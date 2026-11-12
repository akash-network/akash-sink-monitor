import type { Config } from "./config";
import type { MonitorState } from "./model";
import { queueMessage } from "./alerts";
import { formatAkt, slackEscape } from "./format";

export function queueCapResets(
  state: MonitorState,
  config: Config,
  now: number,
) {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const fresh =
    now - Date.parse(snapshot.checkedAt) < config.staleSeconds * 1000;
  const groups = [
    { key: "akash", keys: ["akash-send", "akash-refund"] },
    { key: "solana", keys: ["solana-mint"] },
  ] satisfies { key: "akash" | "solana"; keys: string[] }[];
  const pending = new Set(
    state.outbox.find((message) => message.key === "cap-reset")?.capResetGroups,
  );
  for (const group of groups) {
    const cap = snapshot.caps.find((cap) => group.keys.includes(cap.key));
    if (!cap) continue;
    const previous = state.capPeriods[group.key];
    if (previous === undefined) state.capPeriods[group.key] = cap.period;
    else if (fresh && previous !== cap.period) {
      state.capPeriods[group.key] = cap.period;
      pending.add(group.key);
    }
  }
  if (!fresh || !pending.size) return;
  const sections = ["*♻️ Daily caps reset*"];
  for (const group of groups) {
    if (!pending.has(group.key)) continue;
    const caps = snapshot.caps.filter((cap) => group.keys.includes(cap.key));
    sections.push(
      `*${slackEscape(state.capPeriods[group.key])}*\n` +
        caps
          .map((cap) => {
            const remaining = BigInt(cap.limitUakt) - BigInt(cap.usedUakt);
            return `${slackEscape(cap.label)}: ${formatAkt((remaining > 0n ? remaining : 0n).toString())} / ${formatAkt(cap.limitUakt)} AKT available`;
          })
          .join("\n") +
        (group.key === "akash" ? "\nAccount daily allowances also reset." : ""),
    );
  }
  queueMessage(state, {
    key: "cap-reset",
    fingerprint: [...pending]
      .sort()
      .map((key) => key + ":" + state.capPeriods[key])
      .join("/"),
    capResetGroups: [...pending],
    text: sections.join("\n\n"),
    now,
  });
}
