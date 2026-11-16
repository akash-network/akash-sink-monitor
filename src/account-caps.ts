import assert from "node:assert/strict";
import { QueryEpochInfosResponse } from "@akashnetwork/chain-sdk/private-types/akash.v1beta1";
import type { AkashClient } from "../vendor/akash";
import { sinkIdParts } from "../vendor/id";
import { coinAmount, type decodeRecord } from "../vendor/proof";
import type { Cap } from "./model";

export async function collectAccountCaps(input: {
  akash: AkashClient;
  state: Awaited<ReturnType<AkashClient["state"]>>;
  records: ReturnType<typeof decodeRecord>[];
}): Promise<Cap[]> {
  const { akash, state, records } = input;
  const owners = new Set(records.map((record) => sinkIdParts(record.id).owner));
  if (owners.size === 0) return [];
  const reply = await akash.comet.abciQuery({
    path: "/akash.epochs.v1beta1.Query/EpochInfos",
    data: new Uint8Array(),
    height: state.height,
    prove: false,
  });
  assert.equal(reply.code, 0, "Akash epoch query failed");
  assert.equal(reply.height, state.height, "Akash epoch query height mismatch");
  const epochs = QueryEpochInfosResponse.decode(reply.value).epochs.filter(
    (epoch) => epoch.id === "day",
  );
  assert.equal(epochs.length, 1, "missing or duplicate Akash day epoch");
  const epoch = epochs[0];
  assert.equal(epoch.currentEpoch, state.epoch, "account quota epoch mismatch");
  assert.equal(epoch.epochCountingStarted, state.epoch > 0n);
  if (epoch.epochCountingStarted)
    assert(
      epoch.currentEpochStartHeight > 0n &&
        epoch.currentEpochStartHeight <= BigInt(state.height),
      "invalid Akash epoch start height",
    );
  const recent = records.filter(
    (record) => record.height >= epoch.currentEpochStartHeight,
  );
  const completeWindow =
    epoch.epochCountingStarted &&
    recent.reduce((sum, record) => sum + record.amount, 0n) ===
      coinAmount(state.sendUsage.amount);
  const activeOwners = new Set(
    recent.map((record) => sinkIdParts(record.id).owner),
  );
  const caps: Cap[] = [];
  for (const owner of owners) {
    let used = 0n;
    if (!completeWindow || activeOwners.has(owner)) {
      const account = await akash.account(owner, state.height);
      assert(
        account.usage && account.epoch === state.epoch,
        "account quota epoch mismatch",
      );
      used = coinAmount(account.usage.epochSent);
    }
    caps.push({
      key: "account:" + owner,
      label: "Account " + owner,
      usedUakt: used.toString(),
      limitUakt: coinAmount(state.params.maxEpochAmountPerAccount).toString(),
      period: "Native Akash day epoch " + state.epoch,
    });
  }
  return caps;
}
