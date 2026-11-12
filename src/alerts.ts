import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import type { Config } from "./config";
import type {
  ActivityNotice,
  Alert,
  MonitorState,
  Snapshot,
  Transfer,
} from "./model";
import {
  groupTransferAlerts,
  isIndividualTransferAlert,
} from "./transfer-alerts";
import { squadsUrl, pausePanelUrl } from "./pause";
import { solanaTxLink, transferLinks } from "./links";
import { formatAkt, slackEscape, statusLabel } from "./format";
import {
  postSlackMessage,
  SlackDeliveryError,
  type SlackTarget,
} from "./slack";

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
    transferId?: string;
    activity?: ActivityNotice;
  },
) {
  const { key, fingerprint, text, now } = input;
  // An escalation replaces an undelivered lower-severity notice. A transport
  // retry retains the same message ID and is not counted as a delivery.
  const existing = state.outbox.find((row) => row.key === key);
  if (existing?.fingerprint === fingerprint) {
    existing.text = text;
    existing.transferId = input.transferId;
    existing.activity = input.activity;
    return;
  }
  state.outbox = state.outbox.filter((row) => row.key !== key);
  state.outbox.push({
    id: hash(`${key}:${fingerprint}:${now}`),
    key,
    fingerprint,
    text,
    createdAt: now,
    transferId: input.transferId,
    activity: input.activity,
    activityAdmitted: false,
  });
}

export function updateAlerts(
  state: MonitorState,
  alerts: Alert[],
  config: Config,
  now: number,
) {
  const notifications = groupTransferAlerts(alerts, state.snapshot);
  const active = Object.fromEntries(
    notifications.map((alert) => [alert.key, alert]),
  );
  const previousNotifications = groupTransferAlerts(
    Object.values(state.active),
    state.snapshot,
  );
  state.outbox = state.outbox.filter(
    (message) => !isIndividualTransferAlert(message.key),
  );
  for (const previous of previousNotifications) {
    const key = previous.key;
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
  const previouslyActive = new Set(
    previousNotifications.map((alert) => alert.key),
  );
  for (const alert of notifications) {
    const key = "alert:" + alert.key;
    const fingerprint = alert.severity;
    const sent = state.delivered[key];
    state.outbox = state.outbox.filter(
      (row) => row.key !== key || row.fingerprint !== "resolved",
    );
    if (
      !previouslyActive.has(alert.key) ||
      !sent ||
      sent.fingerprint === "resolved" ||
      (fingerprint === "critical" && sent.fingerprint !== "critical") ||
      now - sent.sentAt >= config.alertRepeatSeconds * 1000 ||
      state.outbox.some((message) => message.key === key)
    ) {
      queueMessage(state, {
        key,
        fingerprint,
        now,
        text: alertText(alert, config, state),
      });
    }
  }
  state.active = Object.fromEntries(alerts.map((alert) => [alert.key, alert]));
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
      transferId: row.id,
      activity: !prior
        ? { kind: "deposit", amountUakt: row.amountUakt }
        : { kind: fingerprint === oldFingerprint ? "receipt" : "update" },
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
        activity: { kind: "burn", amountUakt: burn.amount },
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
  target: SlackTarget;
  persist: () => Promise<void>;
  post?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}) {
  const {
    state,
    target,
    persist,
    post = fetch,
    now = Date.now,
    sleep = setTimeout,
  } = input;
  // Critical messages lead the queue; a burst of transfer events must not
  // delay a backing alert. Slack delivery is at-least-once: a crash
  // after acceptance but before checkpoint can repeat the stable message ID.
  state.outbox.sort(
    (a, b) =>
      Number(b.fingerprint === "critical") -
        Number(a.fingerprint === "critical") ||
      Number(b.key.startsWith("alert:") || b.key === "summary") -
        Number(a.key.startsWith("alert:") || a.key === "summary") ||
      a.createdAt - b.createdAt,
  );
  for (const message of state.outbox.slice(0, 10)) {
    if (target.kind === "bot") {
      const wait = state.slackNextPostAt - now();
      if (wait > 1000) return;
      if (wait > 0) await sleep(wait);
    }
    const parent = message.transferId
      ? state.slackThreads[message.transferId]
      : undefined;
    const threadTs =
      target.kind === "bot" && parent?.channelId === target.channelId
        ? parent.ts
        : undefined;
    const result = await postSlackMessage({
      target,
      text: message.text,
      threadTs,
      post,
    });
    if (result.kind === "rate-limited") {
      state.slackNextPostAt = now() + result.retryAfterMs;
      await persist();
      throw new SlackDeliveryError("Slack delivery rate limited");
    }
    if (result.kind === "thread-missing") {
      if (message.transferId) delete state.slackThreads[message.transferId];
      state.slackNextPostAt = now() + 1000;
      await persist();
      return;
    }
    if (result.kind === "bot") {
      state.slackNextPostAt = now() + 1000;
      if (message.transferId && !threadTs)
        state.slackThreads[message.transferId] = {
          channelId: result.channelId,
          ts: result.ts,
        };
    }
    state.delivered[message.key] = {
      fingerprint: message.fingerprint,
      sentAt: now(),
    };
    state.outbox = state.outbox.filter((row) => row.id !== message.id);
    if (message.key === "activity-digest")
      state.activityNotifications.pending = null;
    await persist();
  }
}
