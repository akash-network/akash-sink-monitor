import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { web3 } from "@coral-xyz/anchor";
import { createSolanaRpcFetch } from "./rpc";

const endpoint = "https://rpc.example/?api-key=test-secret";
const request = {
  method: "POST",
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash" }),
};

function fixture(respond: (attempt: number) => Response, start = 0) {
  let now = start;
  const calls: { at: number; input: string; body: RequestInit["body"] }[] = [];
  const logs: object[] = [];
  const fetch = createSolanaRpcFetch({
    fetch: async (input, init) => {
      calls.push({ at: now, input: String(input), body: init?.body });
      return respond(calls.length);
    },
    now: () => now,
    random: () => 0.5,
    sleep: async (ms, signal) => {
      signal.throwIfAborted();
      now += ms;
    },
    log: (fields) => {
      logs.push(fields);
    },
  });
  return { fetch, calls, logs };
}

test("a throttled SDK read retries the same request and returns verified RPC data", async () => {
  const f = fixture((attempt) =>
    attempt === 1
      ? new Response("throttled", { status: 429 })
      : new Response(
          JSON.stringify({ jsonrpc: "2.0", id: "1", result: "genesis" }),
        ),
  );
  const connection = new web3.Connection(endpoint, {
    disableRetryOnRateLimit: true,
    fetch: f.fetch,
  });
  assert.equal(await connection.getGenesisHash(), "genesis");
  assert.deepEqual(
    f.calls.map((c) => c.at),
    [0, 1000],
  );
  assert.equal(f.calls[0].body, f.calls[1].body);
  assert.deepEqual(f.logs, [
    {
      event: "solana-rpc-retry",
      host: "rpc.example",
      method: "getGenesisHash",
      status: 429,
      attempt: 1,
      delayMs: 1000,
    },
  ]);
  assert(!JSON.stringify(f.logs).includes("test-secret"));
});

test("concurrent callers and later polls share endpoint pacing", async () => {
  const calls: { at: number; url: string }[] = [];
  const fetch = createSolanaRpcFetch({
    fetch: async (input) => {
      calls.push({ at: Date.now(), url: String(input) });
      return new Response("ok");
    },
  });
  await Promise.all([
    fetch(endpoint, request),
    fetch(endpoint, request),
    fetch(endpoint, request),
  ]);
  assert(calls[1].at - calls[0].at >= 240);
  assert(calls[2].at - calls[1].at >= 240);
  await Promise.all([
    fetch(endpoint, request),
    fetch("https://other.example/", request),
  ]);
  assert.equal(calls[3].url, "https://other.example/");
  assert.equal(calls[4].url, endpoint);
  assert(calls[4].at - calls[2].at >= 240);
});

test("persistent throttling stops after four attempts and preserves the cooldown", async () => {
  const f = fixture(() => new Response("throttled", { status: 429 }));
  const response = await f.fetch(endpoint, request);
  assert.equal(response.status, 429);
  assert.equal(await response.text(), "throttled");
  assert.deepEqual(
    f.calls.map((c) => c.at),
    [0, 1000, 3000, 7000],
  );
  assert.equal(f.logs.length, 4);
  assert.match(JSON.stringify(f.logs.at(-1)), /solana-rpc-failed/);
  await f.fetch(endpoint, request);
  assert.equal(f.calls[4].at, 15000);
});

test("Retry-After seconds and dates delay the retry without shortening provider cooldowns", async () => {
  const start = Date.parse("2026-11-12T00:00:00Z");
  for (const header of ["5", new Date(start + 5000).toUTCString()]) {
    const f = fixture(
      (attempt) =>
        attempt === 1
          ? new Response(null, {
              status: 429,
              headers: { "Retry-After": header },
            })
          : new Response("ok"),
      start,
    );
    assert.equal((await f.fetch(endpoint, request)).status, 200);
    assert.equal(f.calls[1].at - f.calls[0].at, 5000);
  }
});

test("transient HTTP failures retry but authentication and RPC errors are returned unchanged", async () => {
  const transient = fixture(
    (attempt) => new Response(null, { status: attempt === 1 ? 503 : 200 }),
  );
  assert.equal((await transient.fetch(endpoint, request)).status, 200);
  assert.equal(transient.calls.length, 2);
  for (const status of [400, 401, 403, 404, 200]) {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "rejected" },
    });
    const f = fixture(() => new Response(body, { status }));
    const response = await f.fetch(endpoint, request);
    assert.equal(response.status, status);
    assert.equal(await response.text(), body);
    assert.equal(f.calls.length, 1);
  }
});

test("caller deadlines cancel backoff and queued requests without another network call", async () => {
  let calls = 0;
  const fetch = createSolanaRpcFetch({
    fetch: async () => {
      calls++;
      return new Response(null, {
        status: 429,
        headers: { "Retry-After": "30" },
      });
    },
    log: () => {},
  });
  const first = new AbortController();
  const second = new AbortController();
  const firstRequest = assert.rejects(
    fetch(endpoint, { ...request, signal: first.signal }),
  );
  await setTimeout(10);
  const secondRequest = assert.rejects(
    fetch(endpoint, { ...request, signal: second.signal }),
  );
  second.abort(new Error("receipt deadline"));
  await secondRequest;
  first.abort(new Error("snapshot deadline"));
  await firstRequest;
  assert.equal(calls, 1);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    fetch(endpoint, { ...request, signal: cancelled.signal }),
  );
  assert.equal(calls, 1);
});

test("request bodies remain usable across retries", async () => {
  const bodies: string[] = [];
  let now = 0;
  const fetch = createSolanaRpcFetch({
    fetch: async (input) => {
      assert(input instanceof Request);
      bodies.push(await input.text());
      return new Response(null, { status: bodies.length === 1 ? 429 : 200 });
    },
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    log: () => {},
  });
  assert.equal((await fetch(new Request(endpoint, request))).status, 200);
  assert.deepEqual(bodies, [request.body, request.body]);
});
