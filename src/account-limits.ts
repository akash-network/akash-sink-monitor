import type { Config } from "./config";
import type { Cap, MonitorState, Snapshot } from "./model";
import { queueMessage } from "./alerts";
import { formatAkt, slackEscape } from "./format";

export function accountLimitsNearCapacity(snapshot: Snapshot, config: Config) {
  return snapshot.caps.filter(
    (cap) =>
      cap.key.startsWith("account:") &&
      BigInt(cap.usedUakt) * 100n >=
        BigInt(cap.limitUakt) * BigInt(config.capWarningPercent),
  );
}

export function accountLimitDetail(cap: Cap): string {
  const remaining = BigInt(cap.limitUakt) - BigInt(cap.usedUakt);
  return `*${slackEscape(cap.label)}*\n${formatAkt(cap.usedUakt)} / ${formatAkt(cap.limitUakt)} AKT used · ${formatAkt((remaining > 0n ? remaining : 0n).toString())} AKT remaining\n${slackEscape(cap.period)}`;
}

export function updateAccountLimitNotices(
  state: MonitorState,
  config: Config,
  now: number,
) {
  // Retire saved account alerts without sending recovery messages or repeating
  // a notice already delivered for the saved snapshot's epoch.
  for (const cap of state.snapshot?.caps ?? []) {
    if (!cap.key.startsWith("account:")) continue;
    const previous = state.delivered["alert:cap:" + cap.key];
    const key = "notice:" + cap.key;
    if (
      state.active["cap:" + cap.key] &&
      previous &&
      previous.fingerprint !== "resolved" &&
      !state.delivered[key]
    )
      state.delivered[key] = {
        fingerprint: cap.period,
        sentAt: previous.sentAt,
      };
  }
  state.active = Object.fromEntries(
    Object.entries(state.active).filter(
      ([key]) => !key.startsWith("cap:account:"),
    ),
  );
  const fresh =
    state.snapshot &&
    now - Date.parse(state.snapshot.checkedAt) < config.staleSeconds * 1000;
  const caps =
    fresh && state.snapshot
      ? accountLimitsNearCapacity(state.snapshot, config)
      : [];
  state.outbox = state.outbox.filter(
    (message) =>
      !message.key.startsWith("alert:cap:account:") &&
      (!message.key.startsWith("notice:account:") ||
        caps.some(
          (cap) =>
            message.key === "notice:" + cap.key &&
            message.fingerprint === cap.period,
        )),
  );
  for (const cap of caps) {
    const key = "notice:" + cap.key;
    if (state.delivered[key]?.fingerprint === cap.period) continue;
    queueMessage(state, {
      key,
      fingerprint: cap.period,
      now,
      text: `*ℹ️ Account deposit limit ${BigInt(cap.usedUakt) >= BigInt(cap.limitUakt) ? "reached" : "nearing capacity"}*\n\n${accountLimitDetail(cap)}\n\nFurther usage will appear in the regular summary.`,
    });
  }
}
