import type { Config } from "./config";
import type { Alert, MonitorState } from "./model";
import { updateAlerts } from "./alerts";

export function observationUnavailable(
  state: MonitorState,
  config: Config,
  now: number,
) {
  const lastSuccess = state.snapshot
    ? Date.parse(state.snapshot.checkedAt)
    : state.startedAt;
  const alert: Alert = {
    key: "observation-unavailable",
    severity:
      now - lastSuccess >= config.staleSeconds * 1000 ? "critical" : "warning",
    title: "Bridge monitoring cannot verify current state",
    detail:
      "RPC data unavailable, stale, inconsistent, or history incomplete. Existing financial alerts remain active; this is not proof of a backing deficit.",
  };
  updateAlerts(
    state,
    [...Object.values(state.active).filter((a) => a.key !== alert.key), alert],
    config,
    now,
  );
  return alert;
}

// One observation remains in flight. Only this caller mutates alert state;
// watchdog delivery cannot race snapshot publication or another poll.
export async function withObservationWatchdog<T>(
  observation: Promise<T>,
  onWait: () => Promise<void>,
  intervalMs = 10_000,
): Promise<T> {
  const result = observation.then(
    (value) => ({ kind: "success" as const, value }),
    (error: unknown) => ({ kind: "failure" as const, error }),
  );
  while (true) {
    let timer: NodeJS.Timeout | undefined;
    try {
      const next = await Promise.race([
        result,
        new Promise<{ kind: "waiting" }>((resolve) => {
          timer = setTimeout(() => resolve({ kind: "waiting" }), intervalMs);
        }),
      ]);
      if (next.kind === "success") return next.value;
      if (next.kind === "failure") throw next.error;
      await onWait();
    } finally {
      clearTimeout(timer);
    }
  }
}
