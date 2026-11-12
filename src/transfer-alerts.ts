import type { Alert, Snapshot } from "./model";
import { formatAkt } from "./format";

const categories = ["pending", "reporter-lag", "refund", "hold", "settlement"];

export function isIndividualTransferAlert(key: string): boolean {
  return categories.some(
    (category) =>
      key.startsWith(`alert:${category}:`) && key !== `alert:${category}:group`,
  );
}

export function groupTransferAlerts(
  alerts: Alert[],
  snapshot: Snapshot | null,
): Alert[] {
  const groups = new Map<string, [Alert, ...Alert[]]>();
  const result: Alert[] = [];
  for (const alert of alerts) {
    const category = categories.find((prefix) =>
      alert.key.startsWith(prefix + ":"),
    );
    if (!category || !alert.transferId) {
      result.push(alert);
      continue;
    }
    const group = groups.get(category);
    if (group) group.push(alert);
    else groups.set(category, [alert]);
  }
  const transfers = new Map(
    snapshot?.transfers.map((transfer) => [transfer.id, transfer]),
  );
  for (const [category, group] of groups) {
    group.sort(
      (a, b) =>
        Number(b.severity === "critical") - Number(a.severity === "critical"),
    );
    const first = group[0];
    if (group.length === 1) {
      result.push({ ...first, key: category + ":group" });
      continue;
    }
    let total = 0n;
    let known = 0;
    for (const alert of group) {
      const transfer = alert.transferId
        ? transfers.get(alert.transferId)
        : undefined;
      if (transfer) {
        total += BigInt(transfer.amountUakt);
        known++;
      }
    }
    result.push({
      key: category + ":group",
      severity: first.severity,
      title: first.title,
      detail: `${group.length.toLocaleString("en-US")} affected transfers${known === group.length ? ` · ${formatAkt(total.toString())} AKT` : ""}.\n\nExamples:\n${group
        .slice(0, 3)
        .map((alert) => `${alert.transferId}: ${alert.detail}`)
        .join(
          "\n\n",
        )}\n\nAll affected transfers remain in the monitor's status and audit records.`,
    });
  }
  return result;
}
