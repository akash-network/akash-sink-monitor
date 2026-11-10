import type { Config } from "./config";
import { akt, type MonitorState } from "./model";
import { queueMessage } from "./alerts";
import { reporterHealth } from "./reporters";

const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function duration(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  if (minutes < 1) return `${Math.floor(Math.max(0, seconds))}s`;
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function healthLines(
  state: MonitorState,
  config: Config,
  now: number,
): string[] {
  const s = state.snapshot;
  if (!s)
    return [
      "Observation: unavailable; no complete snapshot yet. Current bridge health is unknown.",
    ];
  const fresh = now - Date.parse(s.checkedAt) < config.staleSeconds * 1000;
  const lag = BigInt(s.akashHeight) - BigInt(s.client.height);
  const reporters = reporterHealth(state, config, now);
  const coverage = reporters.completeWindow
    ? "full window"
    : `${duration(reporters.coverageSeconds)} coverage; ${reporters.fresh ? "warming up" : "index stale or catching up"}`;
  return [
    fresh
      ? `Observation: fresh (${s.checkedAt})`
      : `Observation: STALE (${s.checkedAt}). Last-known values below; current bridge health is unknown.`,
    `Light client: ${s.client.status}; header ${s.client.height}, age ${duration(s.client.ageSeconds)}, ${lag > 0n ? lag : 0n} blocks behind Akash; trust remaining ${duration(s.client.trustingPeriodSeconds - s.client.ageSeconds)}.`,
    `Reporters: ${reporters.authorized ?? "unknown"} authorized; quorum ${reporters.quorum ?? "unknown"}; ${reporters.recentlyReported ?? "unknown"} reported in the last 2h (${coverage}).`,
    "Reporter activity means successful on-chain reports, not process heartbeats; no traffic can mean zero reports.",
  ];
}

export function summaryText(
  state: MonitorState,
  config: Config,
  now: number,
): string {
  const alerts = Object.values(state.active).sort(
    (a, b) =>
      Number(b.severity === "critical") - Number(a.severity === "critical"),
  );
  const critical = alerts.filter(
    (alert) => alert.severity === "critical",
  ).length;
  const lines = [
    `Akash Sink · ${duration(config.summaryIntervalSeconds)} summary · ${new Date(now).toISOString()}`,
    ...healthLines(state, config, now),
    `Alerts: ${critical} critical, ${alerts.length - critical} warning.`,
    ...alerts
      .slice(0, 5)
      .map((alert) => `${alert.severity.toUpperCase()}: ${alert.title}`),
    ...(alerts.length > 5
      ? [`Plus ${alerts.length - 5} more alerts; see the dashboard.`]
      : []),
  ];
  const s = state.snapshot;
  if (s) {
    const pending = s.transfers.filter((t) =>
      ["STATUS_TRANSFER_PENDING", "STATUS_VOIDED"].includes(t.akash),
    );
    lines.push(
      `Transfers: ${pending.filter((t) => t.solana === "pending").length} awaiting Solana; ${pending.filter((t) => t.solana !== "pending").length} awaiting reports; ${s.transfers.filter((t) => t.akash === "STATUS_REFUND_PENDING").length} refund pending; ${s.transfers.filter((t) => t.hold !== "HOLD_NONE").length} held.`,
      `AKT: escrow ${akt(s.lockedUakt)}; supply ${akt(s.supplyUakt)}; pending ${akt(s.pendingUakt)}; refund pending ${akt(s.refundPendingUakt)}.`,
      `Enabled: deposits ${s.depositsEnabled ? "yes" : "no"}; minting ${s.mintingEnabled ? "yes" : "no"}; refunds ${s.refundsEnabled ? "yes" : "no"}.`,
    );
    for (const cap of s.caps.filter((cap) =>
      ["akash-send", "akash-refund", "solana-mint"].includes(cap.key),
    ))
      lines.push(
        `${cap.label}: ${akt(cap.usedUakt)} / ${akt(cap.limitUakt)} AKT.`,
      );
  }
  lines.push(
    `Slack queue: ${state.outbox.filter((message) => message.key !== "summary").length} other notifications pending.`,
  );
  return (
    lines.map(escape).join("\n") +
    (config.publicUrl ? `\n<${config.publicUrl}|Dashboard>` : "")
  );
}

export function queueSummary(state: MonitorState, config: Config, now: number) {
  const pending = state.outbox.find((message) => message.key === "summary");
  if (pending) {
    pending.text = summaryText(state, config, now);
    return;
  }
  const delivered = state.delivered.summary;
  if (
    delivered &&
    now - delivered.sentAt < config.summaryIntervalSeconds * 1000
  )
    return;
  queueMessage(state, {
    key: "summary",
    fingerprint: "summary",
    text: summaryText(state, config, now),
    now,
  });
}
