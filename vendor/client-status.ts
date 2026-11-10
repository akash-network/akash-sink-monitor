// Adapted from akash-network/node 4373aa92; see vendor/README.md and NODE-LICENSE.
export function clientStatus(input: {
  frozenHeight: bigint;
  consensusTimestampNs: bigint;
  trustingPeriodSeconds: bigint;
  solanaTimeSeconds: bigint;
}): "active" | "expired" | "frozen" {
  if (input.frozenHeight !== 0n) return "frozen";
  const expires =
    input.consensusTimestampNs + input.trustingPeriodSeconds * 1_000_000_000n;
  return input.solanaTimeSeconds * 1_000_000_000n < expires
    ? "active"
    : "expired";
}
