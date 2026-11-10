import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import mainnet from "./mainnet.example.json";
import { web3 } from "@coral-xyz/anchor";
import { base58 } from "@scure/base";
import { TxBody, TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { MsgSink } from "@akashnetwork/chain-sdk/private-types/akash.v1";
import { configSchema, slackWebhook } from "./config";
import {
  monitorStateSchema,
  type MonitorState,
  type Snapshot,
  type Transfer,
  type Alert,
} from "./model";
import { evaluate } from "./policy";
import {
  alertText,
  deliverOutbox,
  updateAlerts,
  updateTransfers,
} from "./alerts";
import { pauseImport, squadsUrl, pausePanelUrl } from "./pause";
import { createHash } from "node:crypto";
import { pda } from "../vendor/common";
import { rejectedDeposits } from "./rejections";
import { metrics, serve } from "./http";
import { once } from "node:events";
import { observationUnavailable, withObservationWatchdog } from "./watchdog";

const config = configSchema.parse(mainnet);
function snapshot(): Snapshot {
  return {
    checkedAt: "2026-11-10T00:00:00.000Z",
    akashHeight: 100,
    solanaSlot: 1000,
    akashTime: 1000,
    solanaTime: 1000,
    lockedUakt: "12000000",
    accountedEscrowUakt: "12000000",
    mintedUakt: "12000000",
    supplyUakt: "12000000",
    burnedUakt: "0",
    depositedUakt: "12000000",
    refundedUakt: "0",
    awaitingReportsUakt: "0",
    pendingUakt: "0",
    refundPendingUakt: "0",
    depositsEnabled: true,
    refundsEnabled: true,
    mintingEnabled: true,
    guardian: config.squadsVault,
    nativeGuardian: "akash1guardian",
    client: {
      status: "active",
      height: "100",
      ageSeconds: 100,
      trustingPeriodSeconds: 1209600,
      program: config.lightClientProgramId,
    },
    caps: [],
    transfers: [],
  };
}
function transfer(): Transfer {
  return {
    id: "akash1sender/100/1",
    owner: "akash1sender",
    recipient: config.squadsVault,
    amountUakt: "1000000",
    depositedAt: 900,
    akash: "STATUS_TRANSFER_PENDING",
    hold: "HOLD_NONE",
    solana: "pending",
    resolvedAtSlot: null,
    resolvedObservedAt: null,
    challengeEnd: "0",
    votes: 0,
    quorum: 4,
    vetoReason: "",
  };
}
function state(): MonitorState {
  return {
    version: 1,
    identity: "test",
    startedAt: 0,
    rejectionHeight: 0,
    snapshot: null,
    active: {},
    delivered: {},
    outbox: [],
    events: [],
    pauseImport: pauseImport(config),
  };
}
const critical: Alert = {
  key: "backing",
  severity: "critical",
  title: "Backing mismatch",
  detail: "1 uakt deficit",
};

test("normal pending deposits do not create a false backing alarm", () => {
  const s = snapshot();
  s.lockedUakt = s.accountedEscrowUakt = s.depositedUakt = "13000000";
  s.pendingUakt = "1000000";
  s.transfers = [transfer()];
  assert.deepEqual(evaluate(s, config), []);
});
test("independent burns reconcile supply; an extra minted unit is critical", () => {
  const s = snapshot();
  s.burnedUakt = "1000000";
  s.supplyUakt = "11000000";
  assert.deepEqual(evaluate(s, config), []);
  s.supplyUakt = "11000001";
  assert.equal(
    evaluate(s, config).find((a) => a.key === "backing")?.severity,
    "critical",
  );
});
test("escrow donation warns; a one-unit deficit is critical", () => {
  const s = snapshot();
  s.lockedUakt = "12000001";
  assert.equal(evaluate(s, config)[0].severity, "warning");
  s.lockedUakt = "11999999";
  assert.equal(evaluate(s, config)[0].severity, "critical");
});
test("minted and refunded cannot both be valid; missing void also alarms", () => {
  const s = snapshot();
  s.transfers = [{ ...transfer(), akash: "STATUS_REFUNDED", solana: "minted" }];
  assert(evaluate(s, config).some((a) => a.key.startsWith("settlement:")));
  s.transfers[0].solana = "pending";
  assert(evaluate(s, config).some((a) => a.key.startsWith("settlement:")));
  s.transfers[0].solana = "voided";
  assert.deepEqual(evaluate(s, config), []);
});
test("refund challenge window is expected; overdue refunds raise an alert", () => {
  const s = snapshot();
  s.transfers = [
    {
      ...transfer(),
      akash: "STATUS_REFUND_PENDING",
      solana: "voided",
      challengeEnd: "1200",
    },
  ];
  assert.deepEqual(evaluate(s, config), []);
  s.akashTime = 1800;
  assert(evaluate(s, config).some((a) => a.key.startsWith("refund:")));
});
test("pending SLA escalates and report lag has its own timer", () => {
  const s = snapshot();
  s.transfers = [transfer()];
  s.akashTime = 1200;
  assert.equal(evaluate(s, config)[0].severity, "warning");
  s.akashTime = 1800;
  assert.equal(evaluate(s, config)[0].severity, "critical");
  s.transfers[0].solana = "minted";
  s.transfers[0].resolvedObservedAt = 1700;
  assert.deepEqual(evaluate(s, config), []);
  s.akashTime = 2300;
  assert.equal(evaluate(s, config)[0].key, "reporter-lag:" + s.transfers[0].id);
});
test("caps use exact integers beyond JavaScript safe number range", () => {
  const s = snapshot();
  s.caps = [
    {
      key: "cap",
      label: "cap",
      period: "native epoch 42",
      usedUakt: "9500000000000000000",
      limitUakt: "10000000000000000000",
    },
  ];
  assert.equal(evaluate(s, config)[0].severity, "critical");
  s.caps[0].usedUakt = "0";
  assert.deepEqual(evaluate(s, config), []);
});
test("frozen client and changed guardian are critical", () => {
  const s = snapshot();
  s.client.status = "frozen";
  s.guardian = null;
  assert.deepEqual(
    evaluate(s, config)
      .map((a) => a.key)
      .sort(),
    ["client", "guardian"],
  );
});
test("critical mention is the exact Slack member ID and includes unsigned pause bytes", () => {
  const cfg = { ...config, slackMemberId: "U12345678" };
  const text = alertText(critical, cfg, state());
  assert(text.includes("<@U12345678>"));
  assert(text.includes(pauseImport(config)));
  assert(text.includes("does NOT pause Akash"));
  assert(
    !alertText({ ...critical, severity: "warning" }, cfg, state()).includes(
      "<@",
    ),
  );
});
test("pause import round-trips only guardian_pause with vault signer", () => {
  const encoded = pauseImport(config);
  const decoded = web3.Transaction.from(base58.decode(encoded));
  const programId = new web3.PublicKey(config.programId);
  assert.equal(decoded.instructions.length, 1);
  assert(
    decoded.instructions[0].data.equals(
      createHash("sha256")
        .update("global:guardian_pause")
        .digest()
        .subarray(0, 8),
    ),
  );
  assert.equal(decoded.instructions[0].programId.toBase58(), config.programId);
  assert.deepEqual(decoded.instructions[0].keys, [
    {
      pubkey: new web3.PublicKey(config.squadsVault),
      isSigner: true,
      isWritable: true,
    },
    { pubkey: pda("guardian", programId), isSigner: false, isWritable: false },
    { pubkey: pda("config", programId), isSigner: false, isWritable: true },
  ]);
  assert(decoded.signatures.every((entry) => entry.signature === null));
});
test("failed Slack delivery survives restart; delivery is recorded only after acceptance", async () => {
  const original = state();
  updateAlerts(original, [critical], config, 1000);
  await assert.rejects(
    deliverOutbox({
      state: original,
      webhook: "https://hooks.slack.com/services/TEST",
      persist: async () => {},
      post: async () => new Response("rate_limited", { status: 429 }),
    }),
  );
  assert.equal(original.outbox.length, 1);
  assert.deepEqual(original.delivered, {});
  const restarted = monitorStateSchema.parse(
    JSON.parse(JSON.stringify(original)),
  );
  let persisted = 0;
  await deliverOutbox({
    state: restarted,
    webhook: "https://hooks.slack.com/services/TEST",
    post: async () => new Response("ok"),
    persist: async () => {
      persisted++;
    },
    now: () => 2000,
  });
  assert.equal(persisted, 1);
  assert.equal(restarted.outbox.length, 0);
  assert.equal(restarted.delivered["alert:backing"].sentAt, 2000);
});
test("warning escalation bypasses cooldown; changing details does not spam", async () => {
  const s = state();
  updateAlerts(s, [{ ...critical, severity: "warning" }], config, 1000);
  await deliverOutbox({
    state: s,
    webhook: "https://hooks.slack.com/services/TEST",
    post: async () => new Response("ok"),
    persist: async () => {},
    now: () => 1000,
  });
  updateAlerts(
    s,
    [{ ...critical, severity: "warning", detail: "changed counter" }],
    config,
    2000,
  );
  assert.equal(s.outbox.length, 0);
  updateAlerts(s, [critical], config, 3000);
  assert.equal(s.outbox.length, 1);
  assert.equal(s.outbox[0].fingerprint, "critical");
});
test("baseline does not announce old transfers; new transitions are durable and deduplicated", () => {
  const s = state(),
    initial = snapshot();
  initial.transfers = [transfer()];
  updateTransfers(s, initial, 1000);
  assert.equal(s.events.length, 0);
  s.snapshot = initial;
  const next = structuredClone(initial);
  next.transfers[0].solana = "minted";
  updateTransfers(s, next, 2000);
  assert.equal(s.events.length, 1);
  s.snapshot = next;
  updateTransfers(s, next, 3000);
  assert.equal(s.events.length, 1);
});
test("failed committed deposits can be found without transaction event indexes", () => {
  const body = TxBody.fromPartial({
    messages: [
      {
        typeUrl: "/akash.sink.v1.MsgSink",
        value: MsgSink.encode(
          MsgSink.fromPartial({
            sender: "akash1sender",
            dest: config.squadsVault,
            amount: { denom: "uakt", amount: "1000000" },
          }),
        ).finish(),
      },
    ],
  });
  const bytes = TxRaw.encode(
    TxRaw.fromPartial({ bodyBytes: TxBody.encode(body).finish() }),
  ).finish();
  assert.deepEqual(rejectedDeposits(bytes, { code: 0 }), []);
  const rejected = rejectedDeposits(bytes, { code: 5, codespace: "sink" });
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].code, 5);
  assert.equal(rejected[0].amount, "1000000");
  assert.match(rejected[0].hash, /^[A-F0-9]{64}$/);
});
test("public metrics expose units and pending deliveries, not Slack message bodies", () => {
  const s = state();
  s.snapshot = snapshot();
  updateAlerts(s, [critical], config, 1000);
  const output = metrics(s, false);
  assert(output.includes("akash_sink_monitor_fresh 0"));
  assert(output.includes("akash_sink_monitor_outbox_pending 1"));
  assert(!output.includes("base58"));
});
test("configuration rejects key material fields and malformed Slack identity", () => {
  assert.throws(() =>
    configSchema.parse({ ...config, keyFile: "/private/key" }),
  );
  assert.throws(() =>
    configSchema.parse({ ...config, slackMemberId: "chalabi" }),
  );
  assert.throws(() =>
    slackWebhook({ SINK_MONITOR_SLACK_WEBHOOK: "https://example.com/collect" }),
  );
  assert.equal(slackWebhook({}), undefined);
});

test("deposit history must equal remaining escrow liabilities plus refunds", () => {
  const s = snapshot();
  s.refundedUakt = "1";
  assert.equal(evaluate(s, config)[0].key, "ledger");
});

test("a recurring critical condition replaces an undelivered recovery, bypassing cooldown", async () => {
  const s = state();
  updateAlerts(s, [critical], config, 1000);
  await deliverOutbox({
    state: s,
    webhook: "https://hooks.slack.com/services/TEST",
    post: async () => new Response("ok"),
    persist: async () => {},
    now: () => 1000,
  });
  updateAlerts(s, [], config, 2000);
  assert.equal(s.outbox[0].fingerprint, "resolved");
  updateAlerts(s, [critical], config, 3000);
  assert.equal(s.outbox.length, 1);
  assert.equal(s.outbox[0].fingerprint, "critical");
});

test("BME-style cooldown suppresses severity reductions until the repeat interval", async () => {
  const s = state();
  updateAlerts(s, [critical], config, 1000);
  await deliverOutbox({
    state: s,
    webhook: "https://hooks.slack.com/services/TEST",
    post: async () => new Response("ok"),
    persist: async () => {},
    now: () => 1000,
  });
  updateAlerts(s, [{ ...critical, severity: "warning" }], config, 2000);
  assert.equal(s.outbox.length, 0);
  updateAlerts(
    s,
    [{ ...critical, severity: "warning" }],
    config,
    1000 + config.alertRepeatSeconds * 1000,
  );
  assert.equal(s.outbox[0].fingerprint, "warning");
});

test("an outage preserves financial alarms and escalates missing observations", () => {
  const s = state();
  updateAlerts(s, [critical], config, 0);
  observationUnavailable(s, config, 1000);
  assert.equal(s.active.backing.severity, "critical");
  assert.equal(s.active["observation-unavailable"].severity, "warning");
  observationUnavailable(s, config, config.staleSeconds * 1000);
  assert.equal(s.active["observation-unavailable"].severity, "critical");
  assert(!s.outbox.some((row) => row.fingerprint === "resolved"));
});

test("watchdog can deliver while an observation is still in flight", async () => {
  let complete: ((value: number) => void) | undefined;
  const task = new Promise<number>((resolve) => {
    complete = resolve;
  });
  let calls = 0;
  const result = await withObservationWatchdog(
    task,
    async () => {
      calls++;
      complete?.(42);
    },
    5,
  );
  assert.equal(result, 42);
  assert.equal(calls, 1);
  await assert.rejects(
    withObservationWatchdog(
      Promise.reject(new Error("offline")),
      async () => {},
    ),
    /offline/,
  );
});

test("Squad links use the vault route and do not invent a prefill query", () => {
  assert.equal(
    squadsUrl(config),
    `https://app.squads.so/squads/${config.squadsVault}/transactions?tab=Vault`,
  );
  assert.equal(pausePanelUrl(config), undefined);
  const cfg = configSchema.parse({
    ...config,
    publicUrl: "https://monitor.example.com",
  });
  assert.equal(pausePanelUrl(cfg), "https://monitor.example.com/#pause-action");
  assert(alertText(critical, cfg, state()).includes(squadsUrl(config)));
  assert(
    alertText(critical, cfg, state()).includes(pausePanelUrl(cfg) ?? "missing"),
  );
  assert.throws(() =>
    configSchema.parse({ ...config, publicUrl: "javascript:alert(1)" }),
  );
});

test("HTTP dashboard serves pause import and links, rejects writes, and marks stale data", async () => {
  const s = state();
  const server = serve({ ...config, listenPort: 0 }, () => s);
  try {
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    const root = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(root + "/healthz")).status, 503);
    s.snapshot = { ...snapshot(), checkedAt: new Date().toISOString() };
    assert.equal((await fetch(root + "/healthz")).status, 200);
    const status = z
      .object({ squadsUrl: z.string(), pauseImport: z.string() })
      .parse(await (await fetch(root + "/status")).json());
    assert.equal(status.squadsUrl, squadsUrl(config));
    assert.equal(status.pauseImport, pauseImport(config));
    assert((await (await fetch(root)).text()).includes('id="copy-pause"'));
    assert.equal(
      (await fetch(root + "/status", { method: "POST" })).status,
      405,
    );
    assert.equal((await fetch(root + "/missing")).status, 404);
  } finally {
    server.close();
    await once(server, "close");
  }
});
