import type { Config } from "./config";
import {
  signatureSchema,
  type ActivityNotice,
  type MonitorState,
} from "./model";
import { queueMessage } from "./alerts";
import { formatAkt, formatDuration, slackEscape } from "./format";

type Batch = NonNullable<MonitorState["activityNotifications"]["pending"]>;

function notice(
  message: MonitorState["outbox"][number],
): ActivityNotice | undefined {
  if (message.activity) return message.activity;
  if (
    message.key.startsWith("transfer:") ||
    message.key.startsWith("rejection-")
  )
    return { kind: "earlier" };
  if (
    message.key.startsWith("burn:") &&
    signatureSchema.safeParse(message.key.slice(5)).success
  )
    return { kind: "earlier" };
  return undefined;
}

export function batchedActivityCount(state: MonitorState): number {
  const batch = state.activityNotifications.pending;
  return batch
    ? batch.deposits +
        batch.updates +
        batch.receipts +
        batch.burns +
        batch.rejections +
        batch.earlier
    : 0;
}

function digestText(batch: Batch, config: Config): string {
  const lines = [
    "*📦 Bridge activity digest*",
    "",
    `Busy period — routine notifications are grouped every ${formatDuration(config.activityDigestSeconds)}.`,
    `*Observed:* <!date^${Math.floor(batch.since / 1000)}^{date_short_pretty} at {time}|${new Date(batch.since).toISOString()}> – <!date^${Math.floor(batch.through / 1000)}^{time}|${new Date(batch.through).toISOString()}>`,
    "",
  ];
  if (batch.deposits)
    lines.push(
      `*New deposits:* ${batch.deposits.toLocaleString("en-US")} · ${formatAkt(batch.depositedUakt)} AKT`,
    );
  if (batch.updates)
    lines.push(`*Status updates:* ${batch.updates.toLocaleString("en-US")}`);
  if (batch.receipts)
    lines.push(`*Receipt updates:* ${batch.receipts.toLocaleString("en-US")}`);
  if (batch.burns)
    lines.push(
      `*Burns:* ${batch.burns.toLocaleString("en-US")} · ${formatAkt(batch.burnedUakt)} AKT`,
    );
  if (batch.rejections)
    lines.push(
      `*Rejected deposit transactions:* ${batch.rejections.toLocaleString("en-US")}`,
    );
  if (batch.earlier)
    lines.push(
      `*Earlier queued notifications:* ${batch.earlier.toLocaleString("en-US")}`,
    );
  if (batch.sampleTransferIds.length)
    lines.push(
      "",
      "*Example transfer IDs*",
      ...batch.sampleTransferIds.map(slackEscape),
    );
  lines.push(
    "",
    "Counts cover grouped notifications; updates may concern the same transfer. Health and financial alerts remain separate.",
  );
  if (config.publicUrl) lines.push(`<${config.publicUrl}|Open dashboard>`);
  return lines.join("\n");
}

export function prepareActivityNotifications(
  state: MonitorState,
  config: Config,
  now: number,
) {
  const activity = state.activityNotifications;
  const interval = config.activityDigestSeconds * 1000;
  if (
    activity.mode.kind === "digest" &&
    !activity.pending &&
    now - activity.mode.lastActivityAt >= interval
  )
    activity.mode = { kind: "individual", recent: [] };
  if (activity.mode.kind === "individual")
    activity.mode.recent = activity.mode.recent.filter(
      (at) => now - at < interval,
    );
  const kept: MonitorState["outbox"] = [];
  let admitted = state.outbox.filter(
    (message) => message.activityAdmitted && notice(message),
  ).length;
  for (const message of state.outbox) {
    const event = notice(message);
    if (
      !event ||
      message.activityAdmitted ||
      message.fingerprint === "critical"
    ) {
      kept.push(message);
      continue;
    }
    if (
      activity.mode.kind === "individual" &&
      activity.mode.recent.length < config.activityBurstLimit &&
      admitted < config.activityBurstLimit
    ) {
      activity.mode.recent.push(now);
      admitted++;
      message.activityAdmitted = true;
      kept.push(message);
      continue;
    }
    activity.mode = { kind: "digest", lastActivityAt: now };
    const batch = (activity.pending ??= {
      since: message.createdAt,
      through: message.createdAt,
      deposits: 0,
      depositedUakt: "0",
      updates: 0,
      receipts: 0,
      burns: 0,
      burnedUakt: "0",
      rejections: 0,
      earlier: 0,
      sampleTransferIds: [],
    });
    batch.since = Math.min(batch.since, message.createdAt);
    batch.through = Math.max(batch.through, message.createdAt);
    if (
      message.transferId &&
      batch.sampleTransferIds.length < 3 &&
      !batch.sampleTransferIds.includes(message.transferId)
    )
      batch.sampleTransferIds.push(message.transferId);
    switch (event.kind) {
      case "deposit":
        batch.deposits++;
        batch.depositedUakt = (
          BigInt(batch.depositedUakt) + BigInt(event.amountUakt)
        ).toString();
        break;
      case "update":
        batch.updates++;
        break;
      case "receipt":
        batch.receipts++;
        break;
      case "burn":
        batch.burns++;
        batch.burnedUakt = (
          BigInt(batch.burnedUakt) + BigInt(event.amountUakt)
        ).toString();
        break;
      case "rejection":
        batch.rejections++;
        break;
      case "earlier":
        batch.earlier++;
        break;
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  }
  state.outbox = kept;
  if (!activity.pending) return;
  const delivered = state.delivered["activity-digest"];
  if (delivered && now - delivered.sentAt < interval) return;
  queueMessage(state, {
    key: "activity-digest",
    fingerprint: "activity-digest",
    text: digestText(activity.pending, config),
    now,
  });
}
