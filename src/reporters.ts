import { z } from "zod";
import { ownerBytes } from "../vendor/id";
import type { Config } from "./config";
import type { MonitorState, ReporterActivity } from "./model";

export const REPORTER_WINDOW_SECONDS = 7200;
const reporterAddress = z.string().refine((value) => {
  try {
    ownerBytes(value);
    return true;
  } catch {
    return false;
  }
});

export function recordReports(
  previous: ReporterActivity | null,
  height: number,
  at: number,
  results: readonly {
    code: number;
    events: readonly {
      type: string;
      attributes: readonly { key: string; value: string }[];
    }[];
  }[],
): ReporterActivity {
  const lastReportAt = Object.fromEntries(
    Object.entries(previous?.lastReportAt ?? {}).filter(
      ([, time]) => time > at - REPORTER_WINDOW_SECONDS,
    ),
  );
  for (const result of results) {
    if (result.code !== 0) continue;
    for (const event of result.events) {
      if (event.type !== "akash.sink.v1.EventOutcomeReported") continue;
      const attribute = event.attributes.find(
        (field) => field.key === "reporter",
      );
      if (!attribute) throw new Error("Report event is missing its reporter");
      const reporter = reporterAddress.parse(JSON.parse(attribute.value));
      lastReportAt[reporter] = at;
    }
  }
  return { since: previous?.since ?? at, through: at, height, lastReportAt };
}

export function reporterHealth(
  state: MonitorState,
  config: Pick<Config, "staleSeconds">,
  now: number,
) {
  const policy = state.snapshot?.reporters;
  const activity = state.reporterActivity;
  const cutoff = now / 1000 - REPORTER_WINDOW_SECONDS;
  const fresh = !!(
    activity &&
    state.snapshot &&
    activity.height === state.snapshot.akashHeight &&
    now - Date.parse(state.snapshot.checkedAt) < config.staleSeconds * 1000 &&
    now / 1000 - activity.through < config.staleSeconds
  );
  return {
    authorized: policy?.members.length ?? null,
    quorum: policy?.quorum ?? null,
    recentlyReported:
      policy && activity
        ? policy.members.filter(
            (member) => (activity.lastReportAt[member] ?? -Infinity) > cutoff,
          ).length
        : null,
    coverageSeconds: activity
      ? Math.max(0, activity.through - Math.max(activity.since, cutoff))
      : 0,
    fresh,
    completeWindow: !!activity && fresh && activity.since <= cutoff,
  };
}
