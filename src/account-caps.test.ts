import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { toBech32 } from "@cosmjs/encoding";
import { Comet38Client } from "@cosmjs/tendermint-rpc";
import {
  QueryAccountRequest,
  QueryAccountResponse,
  QueryStateResponse,
  QueryReportersResponse,
  Sink_QueryParamsResponse,
  TransferState,
} from "@akashnetwork/chain-sdk/private-types/akash.v1";
import { QueryEpochInfosResponse } from "@akashnetwork/chain-sdk/private-types/akash.v1beta1";
import { AkashClient } from "../vendor/akash";
import { decodeRecord } from "../vendor/proof";
import { collectAccountCaps } from "./account-caps";

const coin = (amount: bigint) => ({ denom: "uakt", amount: amount.toString() });
const owner = (n: number) => toBech32("akash", new Uint8Array(20).fill(n));
const record = (n: number, height: bigint, amount = 1_000_000n) =>
  decodeRecord(
    TransferState.fromPartial({
      id: { owner: owner(n), height, sequence: 1n },
      data: {
        amount: coin(amount),
        dest: "H2sXJRVW3SnTdFGjTXpGSsVKN2HnDaKc6xLRomS36H3U",
      },
    }),
  );

function fixture(t: TestContext) {
  const response = QueryStateResponse.fromPartial({
    epoch: 239n,
    totals: {},
    sendUsage: { epoch: 239n, amount: coin(8_000_000n) },
    refundUsage: { epoch: 239n, amount: coin(0n) },
  });
  const { params } = Sink_QueryParamsResponse.fromPartial({
    params: { maxEpochAmountPerAccount: coin(1_000_000_000n) },
  });
  const { reporters } = QueryReportersResponse.fromPartial({
    reporters: [{ version: 1n, members: [owner(1)], threshold: "1" }],
  });
  assert(
    response.totals && response.sendUsage && response.refundUsage && params,
  );
  const state: Awaited<ReturnType<AkashClient["state"]>> = {
    ...response,
    totals: response.totals,
    sendUsage: response.sendUsage,
    refundUsage: response.refundUsage,
    params,
    policy: reporters[0],
    height: 200,
    time: 1000n,
  };
  const epochs = QueryEpochInfosResponse.fromPartial({
    epochs: [
      {
        id: "day",
        currentEpoch: 239n,
        epochCountingStarted: true,
        currentEpochStartHeight: 100n,
      },
    ],
  });
  const records = Array.from({ length: 137 }, (_, i) =>
    record(i + 1, i < 8 ? 100n : 99n),
  );
  const requests: string[] = [];
  const current = {
    epochHeight: 200,
    accountHeight: 200,
    accountEpoch: 239n,
    epochCode: 0,
  };
  t.mock.method(
    Comet38Client.prototype,
    "abciQuery",
    async (
      request: Parameters<Comet38Client["abciQuery"]>[0],
    ): Promise<Awaited<ReturnType<Comet38Client["abciQuery"]>>> => {
      assert.equal(request.height, state.height);
      let value: Uint8Array;
      const isEpoch = request.path === "/akash.epochs.v1beta1.Query/EpochInfos";
      if (isEpoch) {
        value = QueryEpochInfosResponse.encode(epochs).finish();
      } else {
        assert.equal(request.path, "/akash.sink.v1.Query/Account");
        const { owner: address } = QueryAccountRequest.decode(request.data);
        requests.push(address);
        value = QueryAccountResponse.encode({
          epoch: current.accountEpoch,
          usage: {
            lastEpoch: current.accountEpoch,
            epochSent: coin(
              records.some(
                (r) => r.id.startsWith(address + "/") && r.height >= 100n,
              )
                ? 1_000_000n
                : 0n,
            ),
            totalSent: coin(1_000_000n),
          },
        }).finish();
      }
      return {
        code: isEpoch ? current.epochCode : 0,
        codespace: "",
        info: "",
        key: new Uint8Array(),
        height: isEpoch ? current.epochHeight : current.accountHeight,
        value,
      };
    },
  );
  const akash = new AkashClient("https://akash.example", "akashnet-2", 120);
  t.after(() => akash.close());
  return {
    state,
    epochs,
    records,
    requests,
    current,
    collect: () => collectAccountCaps({ akash, state, records }),
  };
}

test("current-epoch quota reads cover boundary deposits and retain every historical account", async (t) => {
  const f = fixture(t);
  const caps = await f.collect();
  assert.equal(caps.length, 137);
  assert.deepEqual(
    f.requests,
    Array.from({ length: 8 }, (_, i) => owner(i + 1)),
  );
  for (const [i, cap] of caps.entries()) {
    assert.equal(cap.key, "account:" + owner(i + 1));
    assert.equal(cap.usedUakt, i < 8 ? "1000000" : "0");
    assert.equal(cap.limitUakt, "1000000000");
    assert.equal(cap.period, "Native Akash day epoch 239");
  }
});

test("epoch rollover clears inactive quotas and follows native heights rather than UTC days", async (t) => {
  const f = fixture(t);
  f.epochs.epochs[0].currentEpoch = f.state.epoch = 240n;
  f.epochs.epochs[0].currentEpochStartHeight = 101n;
  f.state.sendUsage.amount = coin(0n);
  f.state.time = 1001n;
  const caps = await f.collect();
  assert.equal(f.requests.length, 0);
  assert(
    caps.every((cap) => cap.usedUakt === "0" && cap.period.endsWith("240")),
  );
});

test("a window that cannot explain native epoch usage falls back to all account reads", async (t) => {
  const f = fixture(t);
  f.state.sendUsage.amount = coin(9_000_000n);
  const caps = await f.collect();
  assert.equal(f.requests.length, 137);
  assert.equal(caps.length, 137);
});

test("an epoch that has not started uses the complete account query path", async (t) => {
  const f = fixture(t);
  const epoch = f.epochs.epochs[0];
  epoch.currentEpoch = f.state.epoch = f.current.accountEpoch = 0n;
  epoch.epochCountingStarted = false;
  epoch.currentEpochStartHeight = 0n;
  await f.collect();
  assert.equal(f.requests.length, 137);
});

test("epoch query failures and mismatched metadata cannot invent zero account usage", async (t) => {
  for (const defect of [
    "code",
    "height",
    "epoch",
    "duplicate",
    "missing",
    "zero-start",
    "future-start",
    "counting",
  ]) {
    await t.test(defect, async (t) => {
      const f = fixture(t);
      if (defect === "code") f.current.epochCode = 1;
      if (defect === "height") f.current.epochHeight--;
      if (defect === "epoch") f.epochs.epochs[0].currentEpoch--;
      if (defect === "duplicate")
        f.epochs.epochs.push({ ...f.epochs.epochs[0] });
      if (defect === "missing") f.epochs.epochs = [];
      if (defect === "zero-start")
        f.epochs.epochs[0].currentEpochStartHeight = 0n;
      if (defect === "future-start")
        f.epochs.epochs[0].currentEpochStartHeight = 201n;
      if (defect === "counting")
        f.epochs.epochs[0].epochCountingStarted = false;
      await assert.rejects(f.collect());
      assert.equal(f.requests.length, 0);
    });
  }
});

test("active-account queries retain pinned-height and epoch checks", async (t) => {
  for (const defect of ["height", "epoch"]) {
    await t.test(defect, async (t) => {
      const f = fixture(t);
      if (defect === "height") f.current.accountHeight--;
      else f.current.accountEpoch--;
      await assert.rejects(
        f.collect(),
        /query height mismatch|quota epoch mismatch/,
      );
    });
  }
});
