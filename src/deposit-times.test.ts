import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Comet38Client } from "@cosmjs/tendermint-rpc";
import { AkashClient } from "../vendor/akash";
import { collectDepositTimes } from "./deposit-times";

async function fixture(t: TestContext) {
  await mkdir(".cache", { recursive: true });
  const stateDir = await mkdtemp(".cache/deposit-times-");
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const akash = new AkashClient("https://akash.example", "akashnet-2", 120);
  t.after(() => akash.close());
  const state = { height: 2000, time: 10_000n };
  const calls: number[] = [];
  const rpc = {
    chainId: "akashnet-2",
    heightOffset: 0,
    time: 9000,
    failAt: 0,
    elapsedMs: 0,
    calls,
  };
  t.mock.method(Comet38Client.prototype, "block", async (height: number) => {
    rpc.calls.push(height);
    rpc.elapsedMs += 200;
    if (height === rpc.failAt) throw new Error("block RPC unavailable");
    return {
      block: {
        header: {
          chainId: rpc.chainId,
          height: height + rpc.heightOffset,
          time: new Date(rpc.time * 1000),
        },
      },
    };
  });
  return {
    rpc,
    state,
    path: join(stateDir, "deposit-times.json"),
    collect: (heights: bigint[]) =>
      collectDepositTimes({
        akash,
        chainId: "akashnet-2",
        stateDir,
        state,
        heights,
      }),
  };
}

test("timestamp progress survives an expired snapshot and lets the next attempt catch up", async (t) => {
  const f = await fixture(t);
  const heights = Array.from({ length: 1008 }, (_, i) => BigInt(i + 1));
  const attempt = async () => {
    const start = f.rpc.elapsedMs;
    const times = await f.collect(heights);
    assert(
      f.rpc.elapsedMs - start <= 120_000,
      "Akash snapshot expired during collection",
    );
    return times;
  };
  await assert.rejects(attempt(), /snapshot expired during collection/);
  assert.equal(f.rpc.calls.length, 1008);
  f.rpc.calls.length = 0;
  const times = await attempt();
  assert.equal(times.size, 1008);
  assert([...times.values()].every((time) => time === 9000));
  assert.deepEqual(f.rpc.calls, []);
});

test("a failed block lookup retains earlier validated timestamps for the retry", async (t) => {
  const f = await fixture(t);
  f.rpc.failAt = 3;
  await assert.rejects(f.collect([1n, 2n, 3n, 4n]), /RPC unavailable/);
  f.rpc.failAt = 0;
  f.rpc.calls.length = 0;
  assert.equal((await f.collect([1n, 2n, 3n, 4n])).size, 4);
  assert.deepEqual(f.rpc.calls, [3, 4]);
});

test("multiple transfers in one block share a lookup and only new heights need RPC reads", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.collect([1n, 1n, 2n])).size, 2);
  assert.deepEqual(f.rpc.calls, [1, 2]);
  f.rpc.calls.length = 0;
  await f.collect([1n, 2n, 3n]);
  assert.deepEqual(f.rpc.calls, [3]);
});

test("empty timestamp work makes no RPC calls or cache writes", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.collect([])).size, 0);
  assert.deepEqual(f.rpc.calls, []);
  await assert.rejects(readFile(f.path), { code: "ENOENT" });
});

test("invalid block identities and times are never cached", async (t) => {
  for (const defect of ["chain", "height", "future", "negative", "invalid"]) {
    await t.test(defect, async (t) => {
      const f = await fixture(t);
      if (defect === "chain") f.rpc.chainId = "wrong-chain";
      if (defect === "height") f.rpc.heightOffset = 1;
      if (defect === "future") f.rpc.time = 10_001;
      if (defect === "negative") f.rpc.time = -1;
      if (defect === "invalid") f.rpc.time = Number.NaN;
      await assert.rejects(f.collect([1n]), /deposit block/);
      await assert.rejects(readFile(f.path), { code: "ENOENT" });
      f.rpc.chainId = "akashnet-2";
      f.rpc.heightOffset = 0;
      f.rpc.time = 9000;
      assert.equal((await f.collect([1n])).get("1"), 9000);
      assert.deepEqual(f.rpc.calls, [1, 1]);
    });
  }
});

test("cache identity, shape and snapshot bounds remain validated", async (t) => {
  for (const defect of ["chain", "version", "key", "time", "future"]) {
    await t.test(defect, async (t) => {
      const f = await fixture(t);
      await writeFile(
        f.path,
        JSON.stringify({
          version: defect === "version" ? 2 : 1,
          chainId: defect === "chain" ? "wrong-chain" : "akashnet-2",
          times: {
            [defect === "key" ? "01" : "1"]:
              defect === "time" ? "9000" : defect === "future" ? 10_001 : 9000,
          },
        }),
      );
      await assert.rejects(f.collect([1n]));
      assert.deepEqual(f.rpc.calls, []);
    });
  }
  const f = await fixture(t);
  for (const height of [0n, 2001n])
    await assert.rejects(f.collect([height]), /outside native snapshot/);
  assert.deepEqual(f.rpc.calls, []);
});
