import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { AkashRpcClient } from "../vendor/akash-rpc";

const request = {
  jsonrpc: "2.0",
  id: 7,
  method: "abci_query",
  params: {
    path: "/akash.sink.v1.Query/Transfers",
    height: "123",
    data: "abcd",
  },
} satisfies Parameters<AkashRpcClient["execute"]>[0];

async function fixture(
  t: TestContext,
  respond: (response: ServerResponse, attempt: number) => void,
  timeout = 1000,
) {
  const bodies: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(Buffer.concat(chunks).toString());
    respond(res, bodies.length);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const logs: string[] = [];
  const client = new AkashRpcClient(
    `http://127.0.0.1:${address.port}/private-secret?api-key=test-secret`,
    timeout,
    (entry) => {
      logs.push(JSON.stringify(entry));
    },
  );
  return { client, bodies, logs };
}

for (const status of [500, 502, 503, 504]) {
  test(`Akash HTTP ${status} retries the exact pinned read once`, async (t) => {
    const f = await fixture(t, (res, attempt) => {
      res.statusCode = attempt === 1 ? status : 200;
      res.end(
        attempt === 1
          ? "private-body"
          : JSON.stringify({ jsonrpc: "2.0", id: 7, result: { value: "ok" } }),
      );
    });
    assert.deepEqual((await f.client.execute(request)).result, { value: "ok" });
    assert.equal(f.bodies.length, 2);
    assert.equal(f.bodies[0], f.bodies[1]);
    assert.deepEqual(JSON.parse(f.bodies[0]), request);
    assert.match(f.logs.join(""), /akash-rpc-retry/);
    assert(
      !/private-body|test-secret|private-secret|abcd/.test(f.logs.join("")),
    );
  });
}

for (const status of [401, 403, 429, 500]) {
  test(`persistent Akash HTTP ${status} stops within its retry bound`, async (t) => {
    const f = await fixture(t, (res) => {
      res.statusCode = status;
      res.end("private-body");
    });
    await assert.rejects(
      f.client.execute(request),
      new RegExp(`Akash RPC abci_query.*HTTP ${status}`),
    );
    assert.equal(f.bodies.length, status === 500 ? 2 : 1);
    assert(!/private-body|test-secret|private-secret/.test(f.logs.join("")));
  });
}

test("Akash JSON-RPC rejection is not retried or leaked", async (t) => {
  const f = await fixture(t, (res) =>
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        error: { code: -32602, message: "private-body" },
      }),
    ),
  );
  await assert.rejects(
    f.client.execute(request),
    /Akash RPC abci_query failed/,
  );
  assert.equal(f.bodies.length, 1);
  assert(!f.logs.join("").includes("private-body"));
});

test("Akash timeouts are bounded and connection resets can recover", async (t) => {
  const f = await fixture(t, (res, attempt) => {
    if (attempt === 1) res.destroy();
    else res.end(JSON.stringify({ jsonrpc: "2.0", id: 7, result: {} }));
  });
  await f.client.execute(request);
  assert.equal(f.bodies.length, 2);
  const hanging = await fixture(t, () => {}, 30);
  await assert.rejects(
    hanging.client.execute(request),
    /Akash RPC abci_query failed/,
  );
  assert.equal(hanging.bodies.length, 2);
});

test("the read retry adapter never retries a write method", async (t) => {
  const f = await fixture(t, (res) => {
    res.statusCode = 500;
    res.end();
  });
  await assert.rejects(
    f.client.execute({ ...request, method: "broadcast_tx_sync" }),
  );
  assert.equal(f.bodies.length, 1);
});
