// Adapted from akash-network/node 4373aa92; see vendor/README.md and NODE-LICENSE.
import assert from "node:assert/strict";
import type {
  Observation,
  TransferState,
} from "@akashnetwork/chain-sdk/private-types/akash.v1";
function reporterRatio(ratio: string): bigint {
  assert.match(ratio, /^(0|1)(\.[0-9]{1,18})?$/, "invalid reporter ratio");
  const [whole, fraction = ""] = ratio.split(".");
  const value = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
  assert.ok(value <= 10n ** 18n, "reporter ratio must be at most one");
  return value;
}

export function reporterThreshold(ratio: string, count: number): number {
  const scale = 10n ** 18n,
    value = reporterRatio(ratio);
  const members = BigInt(count);
  const threshold = (value * members + scale - 1n) / scale;
  assert.ok(
    count === 0 || 3n * threshold > 2n * members,
    "reporter quorum must exceed two thirds of the members",
  );
  return Number(threshold);
}

export function reportedObservations(transfer: TransferState): Observation[] {
  const settlement = transfer.settlement;
  assert.ok(settlement, "missing settlement");
  return [
    ...(settlement.governanceObservation
      ? [settlement.governanceObservation]
      : []),
    ...settlement.votes.map((vote) => vote.observation),
  ].filter((observation) => observation !== undefined);
}

// Highest reported slot, ignoring slots above slotLimit when one is given.
export function minimumSlot(transfer: TransferState, slotLimit?: bigint) {
  return reportedObservations(transfer).reduce((slot, observation) => {
    const observedSlot = observation.slot;
    return observedSlot > slot &&
      (slotLimit === undefined || observedSlot <= slotLimit)
      ? observedSlot
      : slot;
  }, 0n);
}
