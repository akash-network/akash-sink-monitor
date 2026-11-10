import { createHash } from "node:crypto";
import type { Config } from "./config";
import { akt, type Alert, type MonitorState, type Snapshot } from "./model";
import { squadsUrl, pausePanelUrl } from "./pause";
import { observationLinks, solanaTxLink, transferLinks } from "./links";

function evidence(alert: Alert, config: Config, state: MonitorState): string {
  const snapshot = state.snapshot;
  if (!snapshot) return "";
  const transfer = snapshot.transfers.find(
    (row) => row.id === alert.transferId,
  );
  return `\n${transfer ? transferLinks(transfer, config) + "\n" : ""}${observationLinks(snapshot, config)}`;
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
export function alertText(
  alert: Alert,
  config: Config,
  state: MonitorState,
): string {
  const mention =
    alert.severity === "critical" && config.slackMemberId
      ? `<@${config.slackMemberId}> `
      : "";
  const panel = pausePanelUrl(config);
  const links = `\n<${squadsUrl(config)}|Open your Squad — create a transaction>${panel ? ` · <${panel}|Copy pause import and view instructions>` : ""}`;
  const pause =
    alert.severity !== "critical"
      ? ""
      : state.pauseImport === null
        ? "\nSquads pause import unavailable: verify the configured guardian and chain identity."
        : `\n*Emergency action: pause new Solana mints*${links}\nNew transaction → Add instruction → Import base58 encoded tx. Vault: ${config.squadsVault}. Requires your Squad's approvals.\n\`\`\`${state.pauseImport}\`\`\`\nUnsigned instruction import only; no automatic execution. This does NOT pause Akash deposits/refunds. Use the separate Akash guardian response in the runbook. Snapshot: ${state.snapshot?.checkedAt ?? "unavailable"}.`;
  return `${mention}*${alert.severity.toUpperCase()}: ${escape(alert.title)}*\n${escape(alert.detail)}${evidence(alert, config, state)}${pause}`;
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
  if (existing?.fingerprint === fingerprint) return;
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
        text: `*RESOLVED: ${escape(previous.title)}*\nCondition cleared in a complete fresh snapshot.${evidence(previous, config, state)}`,
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
  if (!previous) {
    queueMessage(state, {
      key: "baseline",
      fingerprint: next.checkedAt,
      now,
      text: `*akash-sink-monitor baseline*\n${next.transfers.length} existing transfers; ${akt(next.lockedUakt)} AKT escrow, ${akt(next.supplyUakt)} Solana supply. Historical transfers are baselined, not announced as new.`,
    });
    return;
  }
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
    const detail = `${row.id}: ${akt(row.amountUakt)} AKT → ${row.recipient}; Akash ${row.akash}; Solana ${row.solana}; ${row.hold}; refund challenge ends ${row.challengeEnd}.`;
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
      text: `*Bridge transfer ${fingerprint === oldFingerprint ? "transaction links available" : prior ? "updated" : "deposited"}*\n${escape(detail)}\n${transferLinks(row, config)}\n${observationLinks(next, config)}`,
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
        text: `*Solana AKT burned*\n${akt(burn.amount)} AKT burned. This is a supply reduction, not a bridge redemption or Akash refund.\n${solanaTxLink(burn.signature, config)}`,
      });
    }
    if (linked !== BigInt(delta))
      queueMessage(state, {
        key: "burn:" + next.burnedUakt,
        fingerprint: next.burnedUakt,
        now,
        text: `*Solana AKT burn receipt coverage incomplete*\nTotal increase ${akt(delta)} AKT; transaction receipts available for ${akt(linked.toString())} AKT. Inspect the persistent burn index. Burns are not bridge redemptions or Akash refunds.\n${observationLinks(next, config)}`,
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
        text: message.text + "\nEvent ID: " + message.id,
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
