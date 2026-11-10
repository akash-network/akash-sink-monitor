import type { Config } from "./config";
import type { Alert, Snapshot } from "./model";

export function evaluate(snapshot: Snapshot, config: Config): Alert[] {
  const alerts: Alert[] = [];
  const add = (
    key: string,
    severity: Alert["severity"],
    title: string,
    detail: string,
    transferId?: string,
  ) => alerts.push({ key, severity, title, detail, transferId });
  const escrowGap =
    BigInt(snapshot.lockedUakt) - BigInt(snapshot.accountedEscrowUakt);
  if (escrowGap !== 0n)
    add(
      "escrow",
      escrowGap < 0n ? "critical" : "warning",
      "Akash escrow differs from recorded liabilities",
      `Bank balance minus pending/minted/void/refund-pending liabilities: ${escrowGap} uakt. Surplus may be an unsolicited donation; a deficit is a backing failure.`,
    );
  const ledgerGap =
    BigInt(snapshot.depositedUakt) -
    BigInt(snapshot.accountedEscrowUakt) -
    BigInt(snapshot.refundedUakt);
  if (ledgerGap !== 0n)
    add(
      "ledger",
      "critical",
      "Akash deposit history differs from settlement totals",
      `Deposited minus recorded escrow liabilities and refunded amount: ${ledgerGap} uakt at height ${snapshot.akashHeight}.`,
    );
  const backingGap =
    BigInt(snapshot.mintedUakt) -
    BigInt(snapshot.supplyUakt) -
    BigInt(snapshot.burnedUakt);
  if (backingGap !== 0n)
    add(
      "backing",
      "critical",
      "Cross-chain backing mismatch",
      `Proven minted deposits minus Solana supply and independently indexed burns: ${backingGap} uakt. Akash height ${snapshot.akashHeight}; finalized Solana slot ${snapshot.solanaSlot}.`,
    );
  for (const cap of snapshot.caps) {
    const used = BigInt(cap.usedUakt),
      limit = BigInt(cap.limitUakt);
    if (limit === 0n) {
      add(
        "cap:" + cap.key,
        "critical",
        cap.label + " has no capacity",
        cap.period,
      );
    } else if (used * 100n >= limit * BigInt(config.capWarningPercent)) {
      add(
        "cap:" + cap.key,
        used * 100n >= limit * BigInt(config.capCriticalPercent)
          ? "critical"
          : "warning",
        cap.label + " approaching limit",
        `${used} / ${limit} uakt; remaining ${limit > used ? limit - used : 0n} uakt. ${cap.period}`,
      );
    }
  }
  if (snapshot.client.status !== "active")
    add(
      "client",
      "critical",
      "Light client " + snapshot.client.status,
      "New proofs cannot be accepted; investigate header delivery/checkpoint recovery.",
    );
  else if (
    snapshot.client.ageSeconds >=
    snapshot.client.trustingPeriodSeconds / 4
  ) {
    add(
      "client",
      snapshot.client.ageSeconds >= snapshot.client.trustingPeriodSeconds / 2
        ? "critical"
        : "warning",
      "Light client approaching expiry",
      `Consensus age ${Math.floor(snapshot.client.ageSeconds)} seconds; trusting period ${snapshot.client.trustingPeriodSeconds} seconds.`,
    );
  }
  if (snapshot.client.program !== config.lightClientProgramId)
    add(
      "client-pin",
      "critical",
      "Bridge light-client pin changed",
      snapshot.client.program,
    );
  if (snapshot.guardian !== config.squadsVault)
    add(
      "guardian",
      "critical",
      "Solana pause guardian changed",
      "Configured Squads pause payload is unavailable until authority is reviewed.",
    );
  for (const transfer of snapshot.transfers) {
    const minted = transfer.solana === "minted";
    const refund = ["STATUS_REFUND_PENDING", "STATUS_REFUNDED"].includes(
      transfer.akash,
    );
    const contradiction =
      (minted && refund) ||
      (transfer.akash === "STATUS_MINTED" && !minted) ||
      (refund && transfer.solana !== "voided");
    if (contradiction)
      add(
        "settlement:" + transfer.id,
        "critical",
        "Contradictory cross-chain settlement",
        `${transfer.id}: Akash ${transfer.akash}, Solana ${transfer.solana}; ${transfer.amountUakt} uakt.`,
        transfer.id,
      );
    if (transfer.hold !== "HOLD_NONE")
      add(
        "hold:" + transfer.id,
        "critical",
        "Transfer requires governance review",
        `${transfer.id}: ${transfer.hold}; ${transfer.vetoReason}`,
        transfer.id,
      );
    const pending = ["STATUS_TRANSFER_PENDING", "STATUS_VOIDED"].includes(
      transfer.akash,
    );
    const age = snapshot.akashTime - transfer.depositedAt;
    if (
      pending &&
      transfer.solana === "pending" &&
      age >= config.pendingWarningSeconds
    ) {
      add(
        "pending:" + transfer.id,
        age >= config.pendingCriticalSeconds ? "critical" : "warning",
        "Transfer remains unresolved",
        `${transfer.id}: pending ${age} seconds; ${transfer.amountUakt} uakt; no finalized Solana result.`,
        transfer.id,
      );
    }
    if (
      pending &&
      transfer.solana !== "pending" &&
      transfer.resolvedObservedAt !== null &&
      snapshot.akashTime - transfer.resolvedObservedAt >=
        config.reportLagSeconds
    ) {
      add(
        "reporter-lag:" + transfer.id,
        "critical",
        "Reporters have not settled a finalized outcome",
        `${transfer.id}: Solana ${transfer.solana}; Akash ${transfer.akash}; votes ${transfer.votes}/${transfer.quorum}.`,
        transfer.id,
      );
    }
    if (
      transfer.akash === "STATUS_REFUND_PENDING" &&
      transfer.hold === "HOLD_NONE" &&
      snapshot.akashTime >=
        Number(transfer.challengeEnd) + config.refundLagSeconds
    ) {
      add(
        "refund:" + transfer.id,
        "critical",
        "Refund overdue after challenge window",
        `${transfer.id}; check refunds enabled, FIFO queue, epoch capacity and reporter delivery. Refunds enabled: ${snapshot.refundsEnabled}.`,
        transfer.id,
      );
    }
  }
  return alerts;
}
