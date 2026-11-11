import type { Config } from "./config";
import type { Alert, Snapshot } from "./model";
import { formatAkt, formatDuration, statusLabel } from "./format";

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
      escrowGap < 0n
        ? `Escrow is short by ${formatAkt((-escrowGap).toString())} AKT.`
        : `Escrow holds ${formatAkt(escrowGap.toString())} AKT more than recorded deposits.`,
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
      `Deposit history and settlement totals differ by ${formatAkt(ledgerGap.toString())} AKT.`,
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
      `Recorded mints and Solana supply plus burns differ by ${formatAkt(backingGap.toString())} AKT.`,
    );
  for (const cap of snapshot.caps) {
    if (cap.key.startsWith("account:")) continue;
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
        `Used ${formatAkt(used.toString())} of ${formatAkt(limit.toString())} AKT.\nRemaining: ${formatAkt((limit > used ? limit - used : 0n).toString())} AKT.`,
      );
    }
  }
  if (snapshot.client.status !== "active")
    add(
      "client",
      "critical",
      "Light client " + snapshot.client.status,
      "New transfers cannot be verified. Check the header relayer and light-client recovery status.",
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
      `The latest header is ${formatDuration(snapshot.client.ageSeconds)} old.\nTrust expires in ${formatDuration(snapshot.client.trustingPeriodSeconds - snapshot.client.ageSeconds)}. Check the header relayer.`,
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
      "The pause guardian no longer matches the configured Squad. Review the on-chain authority.",
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
        `${formatAkt(transfer.amountUakt)} AKT transfer: Akash says ${statusLabel(transfer.akash).toLowerCase()}, Solana says ${transfer.solana}.`,
        transfer.id,
      );
    if (transfer.hold !== "HOLD_NONE")
      add(
        "hold:" + transfer.id,
        "critical",
        "Transfer requires governance review",
        `${formatAkt(transfer.amountUakt)} AKT held for review.\n${statusLabel(transfer.hold)}${transfer.vetoReason ? ": " + transfer.vetoReason : ""}`,
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
        `${formatAkt(transfer.amountUakt)} AKT has been waiting ${formatDuration(age)} for confirmation on Solana.`,
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
        `Solana: ${statusLabel(transfer.solana)}. Reporter votes: ${transfer.votes} of ${transfer.quorum}.\nAkash settlement hasn’t completed.`,
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
        `${formatAkt(transfer.amountUakt)} AKT refund is overdue.\n${snapshot.refundsEnabled ? "Check refund processing, available capacity and reporters." : "Refunds are currently paused."}`,
        transfer.id,
      );
    }
  }
  return alerts;
}
