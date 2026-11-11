import { createHash } from "node:crypto";
import type { Config } from "./config";
import type { Alert, MonitorState, Snapshot, Transfer } from "./model";
import { squadsUrl, pausePanelUrl } from "./pause";
import { solanaTxLink, transferLinks } from "./links";
import { formatAkt, slackEscape, statusLabel } from "./format";

function evidence(alert: Alert, config: Config, state: MonitorState): string {
  if (!alert.transferId) return "";
  const transfer = state.snapshot?.transfers.find(
    (row) => row.id === alert.transferId,
  );
  const links = transfer ? transferLinks(transfer, config) : "";
  return `\n\n*Transfer ID:* ${slackEscape(alert.transferId)}${links ? `\n\n${links}` : ""}`;
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export function alertText(
  alert: Alert,
  config: Config,
  state: MonitorState,
): string {
  const mention =
    alert.severity === "critical" && config.slackMemberId
      ? `<@${config.slackMemberId}>\n`
      : "";
  const icon = alert.severity === "critical" ? "🔴" : "🟠";
  const panel = pausePanelUrl(config);
  const financial =
    ["backing", "escrow", "ledger"].includes(alert.key) ||
    alert.key.startsWith("settlement:");
  const actions =
    alert.severity === "critical" && financial && state.pauseImport !== null
      ? `\n\n*Pause controls*\n${panel ? `<${panel}|Monitor dashboard> · ` : ""}<${squadsUrl(config)}|Open your Squad>`
      : "";
  return `${mention}*${icon} ${slackEscape(alert.title)}*\n\n${slackEscape(alert.detail)}${evidence(alert, config, state)}${actions}`;
}

function transferText(row: Transfer, config: Config, title: string): string {
  const lines = [
    `*${title}*`,
    "",
    `*Transfer ID:* ${slackEscape(row.id)}`,
    `*Amount:* ${formatAkt(row.amountUakt)} AKT`,
    `*Status:* ${statusLabel(row.akash)} · Solana ${row.solana}`,
    `*Recipient:* ${slackEscape(row.recipient)}`,
  ];
  if (row.hold !== "HOLD_NONE")
    lines.push(
      `*Hold:* ${slackEscape(statusLabel(row.hold))}${row.vetoReason ? " — " + slackEscape(row.vetoReason) : ""}`,
    );
  if (row.akash === "STATUS_REFUND_PENDING" && row.challengeEnd !== "0")
    lines.push(
      `*Refund eligible:* <!date^${row.challengeEnd}^{date_short_pretty} at {time}|after the challenge period>`,
    );
  const links = transferLinks(row, config);
  if (links) lines.push("", links);
  return lines.join("\n");
}

export function queueMessage(
  state: MonitorState,
  input: {
    key: string;
    fingerprint: string;
    text: string;
    now: number;
  },
) {
  const { key, fingerprint, text, now } = input;
  // An escalation replaces an undelivered lower-severity notice. A transport
  // retry retains the same message ID and is not counted as a delivery.
  const existing = state.outbox.find((row) => row.key === key);
  if (existing?.fingerprint === fingerprint) {
    existing.text = text;
    return;
  }
  state.outbox = state.outbox.filter((row) => row.key !== key);
  state.outbox.push({
    id: hash(`${key}:${fingerprint}:${now}`),
    key,
    fingerprint,
    text,
    createdAt: now,
  });
}

export function updateAlerts(
  state: MonitorState,
  alerts: Alert[],
  config: Config,
  now: number,
) {
  const active = Object.fromEntries(alerts.map((alert) => [alert.key, alert]));
  for (const [key, previous] of Object.entries(state.active)) {
    if (active[key]) continue;
    state.outbox = state.outbox.filter((row) => row.key !== "alert:" + key);
    if (state.delivered["alert:" + key]) {
      queueMessage(state, {
        key: "alert:" + key,
        fingerprint: "resolved",
        now,
        text:
          key === "observation-unavailable"
            ? "*🟢 Bridge connection restored*\n\nFresh bridge data is available again."
            : `*🟢 Resolved · ${slackEscape(previous.title)}*\n\nThe latest check is clear.${evidence(previous, config, state)}`,
      });
    }
  }
  for (const alert of alerts) {
    const key = "alert:" + alert.key;
    const fingerprint = alert.severity;
    const sent = state.delivered[key];
    state.outbox = state.outbox.filter(
      (row) => row.key !== key || row.fingerprint !== "resolved",
    );
    if (
      !state.active[alert.key] ||
      !sent ||
      sent.fingerprint === "resolved" ||
      (fingerprint === "critical" && sent.fingerprint !== "critical") ||
      now - sent.sentAt >= config.alertRepeatSeconds * 1000
    ) {
      queueMessage(state, {
        key,
        fingerprint,
        now,
        text: alertText(alert, config, state),
      });
    }
  }
  state.active = active;
}

export function updateTransfers(
  state: MonitorState,
  next: Snapshot,
  now: number,
  config: Config,
) {
  const previous = state.snapshot;
  if (!previous) return;
  const old = new Map(previous.transfers.map((row) => [row.id, row]));
  for (const row of next.transfers) {
    const prior = old.get(row.id);
    const fingerprint = [
      row.akash,
      row.solana,
      row.hold,
      row.challengeEnd,
      row.vetoReason,
    ].join(":");
    const oldFingerprint =
      prior &&
      [
        prior.akash,
        prior.solana,
        prior.hold,
        prior.challengeEnd,
        prior.vetoReason,
      ].join(":");
    const receiptsChanged =
      prior &&
      (row.depositTxHash !== prior.depositTxHash ||
        row.solanaTxSignature !== prior.solanaTxSignature);
    if (fingerprint === oldFingerprint && !receiptsChanged) continue;
    const detail = `${row.id}: ${formatAkt(row.amountUakt)} AKT → ${row.recipient}; Akash ${row.akash}; Solana ${row.solana}; ${row.hold}; refund challenge ends ${row.challengeEnd}.`;
    const id = hash(
      [row.id, fingerprint, row.depositTxHash, row.solanaTxSignature].join(":"),
    );
    if (!state.events.some((entry) => entry.id === id)) {
      state.events.push({ id, at: next.checkedAt, detail });
    }
    queueMessage(state, {
      key: "transfer:" + id,
      fingerprint,
      now,
      text: transferText(
        row,
        config,
        fingerprint === oldFingerprint
          ? "🔗 Transfer receipts available"
          : prior
            ? "↔️ Bridge transfer updated"
            : "💸 New bridge deposit",
      ),
    });
  }
  if (BigInt(next.burnedUakt) > BigInt(previous.burnedUakt)) {
    const delta = (
      BigInt(next.burnedUakt) - BigInt(previous.burnedUakt)
    ).toString();
    let linked = 0n;
    for (const burn of next.burns) {
      linked += BigInt(burn.amount);
      queueMessage(state, {
        key: "burn:" + burn.signature,
        fingerprint: burn.signature,
        now,
        text: `*🔥 Solana AKT burned*\n\n*Amount:* ${formatAkt(burn.amount)} AKT\n\n${solanaTxLink(burn.signature, config)}`,
      });
    }
    if (linked !== BigInt(delta))
      queueMessage(state, {
        key: "burn:" + next.burnedUakt,
        fingerprint: next.burnedUakt,
        now,
        text: `*🟠 Some burn receipts are missing*\n\n*Burned:* ${formatAkt(delta)} AKT\n*Receipts found:* ${formatAkt(linked.toString())} AKT\n\nCheck the burn history index.`,
      });
  }
}

export async function deliverOutbox(input: {
  state: MonitorState;
  webhook: string;
  persist: () => Promise<void>;
  post?: typeof fetch;
  now?: () => number;
}) {
  const { state, webhook, persist, post = fetch, now = Date.now } = input;
  // Critical messages lead the queue; a burst of transfer events must not
  // delay a backing alert. Slack incoming webhooks are at-least-once: a crash
  // after acceptance but before checkpoint can repeat the stable message ID.
  state.outbox.sort(
    (a, b) =>
      Number(b.fingerprint === "critical") -
        Number(a.fingerprint === "critical") || a.createdAt - b.createdAt,
  );
  for (const message of state.outbox.slice(0, 10)) {
    const response = await post(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: message.text,
        unfurl_links: false,
        unfurl_media: false,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok || (await response.text()).trim() !== "ok") {
      // Do not include the webhook URL or response body in logs or state.
      throw new Error("Slack delivery failed: HTTP " + response.status);
    }
    state.delivered[message.key] = {
      fingerprint: message.fingerprint,
      sentAt: now(),
    };
    state.outbox = state.outbox.filter((row) => row.id !== message.id);
    await persist();
  }
}
