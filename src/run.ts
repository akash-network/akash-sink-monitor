import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { web3 } from "@coral-xyz/anchor";
import { atomicJson, optionalJson, withUploadLock } from "../vendor/durable";
import { configSchema, slackWebhook, type Config } from "./config";
import { monitorStateSchema, type MonitorState } from "./model";
import { collectSnapshot } from "./snapshot";
import { evaluate } from "./policy";
import { pauseImport } from "./pause";
import {
  deliverOutbox,
  queueMessage,
  updateAlerts,
  updateTransfers,
} from "./alerts";
import { serve } from "./http";
import { scanTransactions } from "./transactions";
import { queueSummary } from "./summary";
import { akashTxLink } from "./links";
import { observationUnavailable, withObservationWatchdog } from "./watchdog";

const log = (event: string, fields: object = {}) =>
  process.stdout.write(
    JSON.stringify({ time: new Date().toISOString(), event, ...fields }) + "\n",
  );

export async function poll(config: Config, state: MonitorState) {
  // Every attempt is a complete snapshot on one endpoint per chain. Never
  // combine pages from different RPCs into a supposedly coherent observation.
  for (let a = 0; a < config.akashRpcs.length; a++) {
    for (let s = 0; s < config.solanaRpcs.length; s++) {
      try {
        const connection = new web3.Connection(config.solanaRpcs[s], {
          commitment: "finalized",
          disableRetryOnRateLimit: true,
          fetch: async (url, init) =>
            fetch(url, { ...init, signal: AbortSignal.timeout(20_000) }),
        });
        const snapshot = await collectSnapshot(
          config,
          connection,
          config.akashRpcs[a],
          state.snapshot,
        );
        if (
          state.snapshot &&
          (snapshot.akashHeight < state.snapshot.akashHeight ||
            snapshot.solanaSlot < state.snapshot.solanaSlot)
        )
          throw new Error("RPC snapshot regressed");
        return { snapshot, akashRpc: config.akashRpcs[a] };
      } catch (error) {
        // RPC URLs can contain API credentials. Do not serialize raw SDK
        // exceptions or HTTP response bodies into Slack or durable state.
        log("snapshot-attempt-failed", {
          akashEndpoint: a,
          solanaEndpoint: s,
          errorType: error instanceof Error ? error.name : "unknown",
          reason:
            error instanceof Error
              ? error.message.replace(
                  /https?:\/\/[^\s"'<>]+/g,
                  "[RPC endpoint]",
                )
              : "unknown",
        });
      }
    }
  }
  throw new Error(
    "No configured RPC pair produced a complete verified snapshot",
  );
}

export async function run(
  config: Config,
  options: { once: boolean; notify: boolean },
) {
  const webhook = options.notify ? slackWebhook(process.env) : undefined;
  if (options.notify) {
    assert(webhook, "--notify requires SINK_MONITOR_SLACK_WEBHOOK");
    assert(
      config.slackMemberId,
      "--notify requires your Slack member ID; display names do not notify reliably",
    );
  }
  const identity = [
    config.akashChainId,
    config.solanaGenesis,
    config.programId,
    config.mint,
    config.squadsVault,
  ].join("/");
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  await withUploadLock(join(config.stateDir, "monitor.lock"), async () => {
    const file = join(config.stateDir, "monitor-state.json");
    const saved = await optionalJson(file);
    const state: MonitorState =
      saved === undefined
        ? {
            version: 1,
            identity,
            startedAt: Date.now(),
            rejectionHeight: 0,
            reporterActivity: null,
            snapshot: null,
            active: {},
            delivered: {},
            outbox: [],
            events: [],
            pauseImport: null,
          }
        : monitorStateSchema.parse(saved);
    assert.equal(
      state.identity,
      identity,
      "state directory belongs to another deployment",
    );
    const persist = async () => {
      // Audit events are written before advancing the snapshot. Stable IDs
      // make a repeated write after a crash harmless.
      for (const event of state.events)
        await atomicJson(
          join(config.stateDir, "events", event.id + ".json"),
          event,
        );
      state.events = state.events.slice(-200);
      await atomicJson(file, state);
    };
    const notify = async () => {
      if (!webhook) return;
      try {
        await deliverOutbox({ state, webhook, persist });
      } catch {
        log("slack-delivery-failed", { queued: state.outbox.length });
      }
    };
    const watchdog = async () => {
      const now = Date.now();
      observationUnavailable(state, config, now);
      if (options.notify && !options.once) queueSummary(state, config, now);
      await persist();
      await notify();
    };
    let stopped = false;
    const stop = () => {
      stopped = true;
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    const server = options.once ? undefined : serve(config, () => state);
    log("monitor-start", {
      programId: config.programId,
      mint: config.mint,
      notifications: options.notify,
      channelLabel: config.slackChannel,
    });
    try {
      do {
        const now = Date.now();
        let success = false;
        try {
          const { snapshot, akashRpc } = await withObservationWatchdog(
            poll(config, state),
            watchdog,
          );
          state.pauseImport =
            snapshot.guardian === config.squadsVault
              ? pauseImport(config)
              : null;
          updateTransfers(state, snapshot, now, config);
          state.snapshot = snapshot;
          const alerts = evaluate(snapshot, config);
          updateAlerts(
            state,
            [
              ...alerts,
              ...Object.values(state.active).filter(
                (alert) => alert.key === "rejection-index",
              ),
            ],
            config,
            Date.now(),
          );
          try {
            const indexed = await withObservationWatchdog(
              scanTransactions(
                config,
                akashRpc,
                state.rejectionHeight,
                snapshot.akashHeight,
                snapshot.akashTime,
                state.reporterActivity,
              ),
              watchdog,
            );
            state.rejectionHeight = indexed.height;
            state.reporterActivity = indexed.activity;
            for (const event of indexed.events) {
              if (!state.events.some((entry) => entry.id === event.id))
                state.events.push(event);
              queueMessage(state, {
                key: event.id,
                fingerprint: event.id,
                now,
                text:
                  "*🔴 Deposit rejected*\n\nThe deposit was not accepted on Akash.\n\n" +
                  akashTxLink(event.txHash, config),
              });
            }
            if (indexed.height < snapshot.akashHeight)
              alerts.push({
                key: "rejection-index",
                severity: "warning",
                title: "Catching up on transaction history",
                detail: `${snapshot.akashHeight - indexed.height} blocks left to scan. Reporter activity will update as the scan completes.`,
              });
          } catch {
            alerts.push({
              key: "rejection-index",
              severity: "critical",
              title: "Transaction history is unavailable",
              detail:
                "Reporter activity cannot update. Check that the Akash RPC retains historical block results.",
            });
          }
          updateAlerts(state, alerts, config, now);
          if (
            Date.now() - Date.parse(snapshot.checkedAt) >=
            config.staleSeconds * 1000
          )
            observationUnavailable(state, config, Date.now());
          success = true;
          log("snapshot", {
            akashHeight: snapshot.akashHeight,
            solanaSlot: snapshot.solanaSlot,
            supplyUakt: snapshot.supplyUakt,
            pendingUakt: snapshot.pendingUakt,
            alerts: Object.keys(state.active),
          });
        } catch {
          const alert = observationUnavailable(state, config, Date.now());
          log("observation-unavailable", {
            severity: alert?.severity ?? "retrying",
          });
        }
        if (options.notify && !options.once)
          queueSummary(state, config, Date.now());
        await persist();
        await notify();
        if (options.once) {
          if (!success)
            throw new Error(
              "Read-only monitor check failed; inspect health and RPC availability",
            );
          break;
        }
        for (let i = 0; i < config.intervalSeconds && !stopped; i++) {
          await new Promise((done) => setTimeout(done, 1000));
        }
      } while (!stopped);
    } finally {
      server?.close();
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
    }
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      once: { type: "boolean", default: false },
      notify: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
    },
  });
  assert(
    values.config,
    "Usage: npm run monitor -- --config /absolute/config.json [--once] [--notify] [--check]",
  );
  const config = configSchema.parse(
    JSON.parse(await readFile(resolve(values.config), "utf8")),
  );
  if (values.check) {
    log("configuration-valid", {
      notificationsReady: Boolean(
        config.slackMemberId && slackWebhook(process.env),
      ),
    });
    return;
  }
  await run(config, { once: values.once, notify: values.notify });
}
if (require.main === module)
  void main().catch((error: unknown) => {
    log("monitor-fatal", {
      error: error instanceof Error ? error.message : "Monitor failed",
    });
    process.exitCode = 1;
  });
