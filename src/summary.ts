import type { Config } from "./config";
import type { MonitorState } from "./model";
import { queueMessage } from "./alerts";
import { reporterHealth } from "./reporters";
import {
  formatAkt,
  formatDuration as duration,
  slackEscape,
  statusLabel,
} from "./format";

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
  const s = state.snapshot;
  const fresh =
    !!s && now - Date.parse(s.checkedAt) < config.staleSeconds * 1000;
  const alerts = Object.values(state.active).sort(
    (a, b) =>
      Number(b.severity === "critical") - Number(a.severity === "critical"),
  );
  const icon =
    !fresh || alerts.some((alert) => alert.severity === "critical")
      ? "🔴"
      : alerts.length
        ? "🟠"
        : "🟢";
  const title = !fresh
    ? "Updates unavailable"
    : alerts.length
      ? "Needs attention"
      : "All clear";
  const sections = [`*${icon} Akash Sink · ${title}*`];
  if (!fresh) {
    sections.push(
      s
        ? `No new bridge data for *${duration((now - Date.parse(s.checkedAt)) / 1000)}*.\nCheck the RPC connections. Balances below are from the last successful check.`
        : "Waiting for the first bridge check.\nCheck the Akash and Solana RPC connections.",
    );
  } else if (s) {
    const lag = BigInt(s.akashHeight) - BigInt(s.client.height);
    sections.push(
      `*Light client*\n${statusLabel(s.client.status)} · header age ${duration(s.client.ageSeconds)} · trust remaining ${duration(s.client.trustingPeriodSeconds - s.client.ageSeconds)}\nHeader ${BigInt(s.client.height).toLocaleString("en-US")} · ${(lag > 0n ? lag : 0n).toLocaleString("en-US")} blocks behind`,
    );
    const reporters = reporterHealth(state, config, now);
    const activity =
      reporters.recentlyReported === null
        ? "Collecting report history"
        : `${reporters.recentlyReported} reported in the last 2h${reporters.completeWindow ? "" : reporters.fresh ? ` · ${duration(reporters.coverageSeconds)} tracked so far` : " · history catching up"}`;
    sections.push(
      `*Reporters*\n${reporters.authorized ?? "Unknown"} authorized · quorum ${reporters.quorum ?? "unknown"}\n${activity}`,
    );
    const pending = s.transfers.filter((t) =>
      ["STATUS_TRANSFER_PENDING", "STATUS_VOIDED"].includes(t.akash),
    );
    const held = s.transfers.filter((t) => t.hold !== "HOLD_NONE").length;
    sections.push(
      `*Transfers*\n${pending.filter((t) => t.solana === "pending").length} pending · ${pending.filter((t) => t.solana !== "pending").length} awaiting reports · ${s.transfers.filter((t) => t.akash === "STATUS_REFUND_PENDING").length} refunds pending${held ? ` · ${held} held for review` : ""}`,
    );
    const paused = [
      !s.depositsEnabled ? "deposits" : "",
      !s.mintingEnabled ? "minting" : "",
      !s.refundsEnabled ? "refunds" : "",
    ].filter(Boolean);
    sections.push(
      `*Bridge*\nEscrow: *${formatAkt(s.lockedUakt)} AKT* · Supply: *${formatAkt(s.supplyUakt)} AKT*\n${paused.length ? `Paused: ${paused.join(", ")}` : "Deposits, minting and refunds enabled"}`,
    );
    const caps = s.caps.filter((cap) =>
      ["akash-send", "akash-refund", "solana-mint"].includes(cap.key),
    );
    if (caps.length)
      sections.push(
        "*Daily usage*\n" +
          caps
            .map(
              (cap) =>
                `${slackEscape(cap.label)}: ${formatAkt(cap.usedUakt)} / ${formatAkt(cap.limitUakt)} AKT`,
            )
            .join("\n"),
      );
  }
  if (s && !fresh)
    sections.push(
      `*Last confirmed balances*\nEscrow: ${formatAkt(s.lockedUakt)} AKT · Supply: ${formatAkt(s.supplyUakt)} AKT`,
    );
  const issues = alerts.filter(
    (alert) => alert.key !== "observation-unavailable",
  );
  if (issues.length)
    sections.push(
      "*Open issues*\n" +
        issues
          .slice(0, 5)
          .map((alert) => `• ${slackEscape(alert.title)}`)
          .join("\n") +
        (issues.length > 5
          ? `\nPlus ${issues.length - 5} more in the dashboard`
          : ""),
    );
  if (config.publicUrl) sections.push(`<${config.publicUrl}|Open dashboard>`);
  return sections.join("\n\n");
}

export function queueSummary(state: MonitorState, config: Config, now: number) {
  if (!state.snapshot) {
    state.outbox = state.outbox.filter(
      (message) => message.key !== "summary" && message.key !== "baseline",
    );
    return;
  }
  const recovery = state.outbox.some(
    (message) =>
      message.key === "alert:observation-unavailable" &&
      message.fingerprint === "resolved",
  );
  state.outbox = state.outbox.filter(
    (message) =>
      message.key !== "baseline" &&
      !(recovery && message.key === "alert:observation-unavailable"),
  );
  const pending = state.outbox.find((message) => message.key === "summary");
  if (pending) {
    pending.text = summaryText(state, config, now);
    return;
  }
  const delivered = state.delivered.summary;
  if (
    !recovery &&
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
