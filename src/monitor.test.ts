import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import mainnet from "./mainnet.example.json";
import { web3 } from "@coral-xyz/anchor";
import { base58 } from "@scure/base";
import { TxBody, TxRaw, AuthInfo } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { TxMsgData } from "cosmjs-types/cosmos/base/abci/v1beta1/abci";
import {
  MsgSink,
  MsgSinkResponse,
  DestType,
} from "@akashnetwork/chain-sdk/private-types/akash.v1";
import { configSchema, slackWebhook } from "./config";
import {
  monitorStateSchema,
  type MonitorState,
  type Snapshot,
  type Transfer,
  type Alert,
  snapshotSchema,
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
import { rejectedDeposits } from "./transactions";
import { metrics, serve } from "./http";
import { once } from "node:events";
import { observationUnavailable, withObservationWatchdog } from "./watchdog";
import { depositReceipt, isResolutionReceipt, burnReceipts } from "./receipts";
import { akashTxLink, solanaTxLink, transferLinks } from "./links";
import { parseSinkId } from "../vendor/id";
import { statusAddress } from "../vendor/proof";
import idl from "../idl/akt.json";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { toBech32 } from "@cosmjs/encoding";
import { recordReports, reporterHealth } from "./reporters";
import { queueSummary, summaryText } from "./summary";
import { Script } from "node:vm";
import { formatAkt } from "./format";
import { updateAccountLimitNotices } from "./account-limits";

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
    reporters: { version: "1", members: [], quorum: 0 },
    caps: [],
    transfers: [],
    burns: [],
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
    depositTxHash: null,
    solanaTxSignature: null,
    receiptCheckedAt: 0,
  };
}
function state(): MonitorState {
  return {
    version: 1,
    identity: "test",
    startedAt: 0,
    rejectionHeight: 0,
    reporterActivity: null,
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
test("account limits notify once per native epoch, including across restarts", async () => {
  let s = state();
  s.snapshot = snapshot();
  const now = Date.parse(s.snapshot.checkedAt);
  s.snapshot.caps = [
    {
      key: "account:akash1sender",
      label: "Account akash1sender",
      period: "Native Akash day epoch 42",
      usedUakt: "790000",
      limitUakt: "1000000",
    },
  ];
  updateAccountLimitNotices(s, config, now);
  assert.equal(s.outbox.length, 0);
  s.snapshot.caps[0].usedUakt = "800000";
  updateAccountLimitNotices(s, config, now);
  assert.equal(s.outbox.length, 1);
  assert.match(s.outbox[0].text, /ℹ️ Account deposit limit nearing capacity/);
  assert(!s.outbox[0].text.includes("<@"));
  await deliverOutbox({
    state: s,
    webhook: "https://hooks.slack.com/services/TEST",
    post: async () => new Response("ok"),
    persist: async () => {},
    now: () => now,
  });
  s = monitorStateSchema.parse(JSON.parse(JSON.stringify(s)));
  assert(s.snapshot);
  const later = now + 3 * 3600_000;
  s.snapshot.checkedAt = new Date(later).toISOString();
  for (const used of ["950000", "1000000", "0", "800000"]) {
    s.snapshot.caps[0].usedUakt = used;
    s.active = Object.fromEntries(
      evaluate(s.snapshot, config).map((a) => [a.key, a]),
    );
    updateAccountLimitNotices(s, config, later);
    assert.equal(s.outbox.length, 0);
    assert.deepEqual(s.active, {});
  }
  const summary = summaryText(s, config, later);
  assert.match(summary, /🟢 Akash Sink · All clear/);
  assert.match(summary, /\*Account limits\*/);
  assert.match(summary, /0.8 \/ 1 AKT used · 0.2 AKT remaining/);
  assert.match(
    metrics(s, true, config, later),
    /akash_sink_monitor_critical_alerts 0/,
  );
  s.snapshot.caps[0].period = "Native Akash day epoch 43";
  updateAccountLimitNotices(s, config, later);
  assert.equal(s.outbox.length, 1);
  assert.match(s.outbox[0].text, /epoch 43/);
});
test("undelivered account notices refresh and disappear when no longer current", () => {
  const s = state();
  s.snapshot = snapshot();
  const now = Date.parse(s.snapshot.checkedAt);
  s.snapshot.caps = [
    {
      key: "account:akash1sender",
      label: "Account akash1sender",
      period: "Native Akash day epoch 42",
      usedUakt: "800000",
      limitUakt: "1000000",
    },
  ];
  updateAccountLimitNotices(s, config, now);
  const id = s.outbox[0].id;
  s.snapshot.caps[0].usedUakt = "1000000";
  updateAccountLimitNotices(s, config, now + 1000);
  assert.equal(s.outbox[0].id, id);
  assert.match(s.outbox[0].text, /limit reached/);
  assert.match(s.outbox[0].text, /0 AKT remaining/);
  updateAccountLimitNotices(s, config, now + config.staleSeconds * 1000);
  assert.equal(s.outbox.length, 0);
  assert(
    !summaryText(s, config, now + config.staleSeconds * 1000).includes(
      "*Account limits*",
    ),
  );
  updateAccountLimitNotices(s, config, now);
  assert.equal(s.outbox.length, 1);
  s.snapshot.caps[0].usedUakt = "0";
  s.snapshot.caps[0].period = "Native Akash day epoch 43";
  updateAccountLimitNotices(s, config, now);
  assert.equal(s.outbox.length, 0);
  s.snapshot.caps[0].limitUakt = "0";
  updateAccountLimitNotices(s, config, now);
  assert.deepEqual(evaluate(s.snapshot, config), []);
  assert.match(s.outbox[0].text, /ℹ️ Account deposit limit reached/);
});
test("saved account alerts retire quietly while financial incidents stay active", async () => {
  const s = state();
  s.snapshot = snapshot();
  const now = Date.parse(s.snapshot.checkedAt);
  s.snapshot.caps = [
    {
      key: "account:akash1sender",
      label: "Account akash1sender",
      period: "Native Akash day epoch 42",
      usedUakt: "1000000",
      limitUakt: "1000000",
    },
  ];
  const legacy: Alert = {
    key: "cap:account:akash1sender",
    severity: "critical",
    title: "Account approaching limit",
    detail: "Used 1 of 1 AKT",
  };
  updateAlerts(s, [legacy, critical], config, now);
  await deliverOutbox({
    state: s,
    webhook: "https://hooks.slack.com/services/TEST",
    post: async () => new Response("ok"),
    persist: async () => {},
    now: () => now,
  });
  const later = now + config.alertRepeatSeconds * 1000;
  s.snapshot.checkedAt = new Date(later).toISOString();
  updateAlerts(s, [legacy, critical], config, later);
  assert.equal(s.outbox.length, 2);
  const restored = monitorStateSchema.parse(JSON.parse(JSON.stringify(s)));
  updateAccountLimitNotices(restored, config, later);
  updateAlerts(restored, [critical], config, later);
  assert.deepEqual(Object.keys(restored.active), [critical.key]);
  assert.deepEqual(
    restored.outbox.map((message) => message.key),
    ["alert:backing"],
  );
  assert.equal(
    restored.delivered["notice:account:akash1sender"].fingerprint,
    "Native Akash day epoch 42",
  );
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
test("critical alerts keep the operator mention and pause links without dumping transaction bytes", () => {
  const cfg = { ...config, slackMemberId: "U12345678" };
  const text = alertText(critical, cfg, state());
  assert(text.includes("<@U12345678>"));
  assert(text.includes(squadsUrl(config)));
  assert(!text.includes(pauseImport(config)));
  assert.match(text, /\*🔴 Backing mismatch\*\n\n/);
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
  updateTransfers(s, initial, 1000, config);
  assert.equal(s.events.length, 0);
  s.snapshot = initial;
  const next = structuredClone(initial);
  next.transfers[0].solana = "minted";
  updateTransfers(s, next, 2000, config);
  assert.equal(s.events.length, 1);
  s.snapshot = next;
  updateTransfers(s, next, 3000, config);
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
  const output = metrics(s, false, config);
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
  assert(!Object.hasOwn(s.active, "observation-unavailable"));
  observationUnavailable(s, config, config.startupGraceSeconds * 1000);
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
      .object({
        squadsUrl: z.string(),
        pauseImport: z.string(),
        health: z.array(z.string()),
      })
      .parse(await (await fetch(root + "/status")).json());
    assert.equal(status.squadsUrl, squadsUrl(config));
    assert.equal(status.pauseImport, pauseImport(config));
    assert(status.health.some((line) => line.includes("Light client: active")));
    const html = await (await fetch(root)).text();
    assert(html.includes('id="copy-pause"'));
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert(script);
    new Script(script);
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

const receiptOwner = "akash1uwqjtgjhjctjc45ugy7ev5prprhehc7w5xcfwl";
const receiptSignature = base58.encode(new Uint8Array(64).fill(1));
function receiptTransfer(): Transfer {
  return {
    ...transfer(),
    id: `${receiptOwner}/100/1`,
    owner: receiptOwner,
  };
}
function depositFixture(sequence = 1n) {
  const row = receiptTransfer();
  const message = MsgSink.fromPartial({
    sender: row.owner,
    dest: row.recipient,
    destType: DestType.DEST_TYPE_SOLANA,
    amount: { denom: "uakt", amount: row.amountUakt },
  });
  const bytes = TxRaw.encode(
    TxRaw.fromPartial({
      bodyBytes: TxBody.encode(
        TxBody.fromPartial({
          messages: [
            {
              typeUrl: "/akash.sink.v1.MsgSink",
              value: MsgSink.encode(message).finish(),
            },
          ],
        }),
      ).finish(),
      authInfoBytes: AuthInfo.encode(AuthInfo.fromPartial({})).finish(),
    }),
  ).finish();
  const data = TxMsgData.encode(
    TxMsgData.fromPartial({
      msgResponses: [
        {
          typeUrl: "/akash.sink.v1.MsgSinkResponse",
          value: MsgSinkResponse.encode(
            MsgSinkResponse.fromPartial({
              id: { owner: row.owner, height: 100n, sequence },
            }),
          ).finish(),
        },
      ],
    }),
  ).finish();
  return { bytes, result: { code: 0, data } };
}

test("deposit links bind raw transaction, response ID and every immutable field", () => {
  const { bytes, result } = depositFixture();
  const hash = createHash("sha256").update(bytes).digest("hex").toUpperCase();
  const row = receiptTransfer();
  assert.equal(depositReceipt(bytes, result, row), hash);
  assert.equal(depositReceipt(bytes, { ...result, code: 5 }, row), null);
  assert.equal(depositReceipt(bytes, depositFixture(2n).result, row), null);
  for (const wrong of [
    { ...row, amountUakt: "2" },
    { ...row, recipient: config.mint },
    { ...row, owner: "another" },
    { ...row, id: `${receiptOwner}/101/1` },
  ])
    assert.equal(depositReceipt(bytes, result, wrong), null);
  assert.equal(
    depositReceipt(bytes, { code: 0, data: new Uint8Array() }, row),
    null,
  );
  assert.equal(depositReceipt(new Uint8Array(), result, row), null);
  assert.match(akashTxLink(hash, config), new RegExp(`/akash/tx/${hash}`));
});

function resolutionFixture(
  name: "mint_transfer" | "void_transfer",
): web3.ParsedTransactionWithMeta {
  const definition = idl.instructions.find(
    (instruction) => instruction.name === name,
  );
  assert(definition);
  const row = receiptTransfer();
  return {
    slot: 1100,
    meta: { err: null, fee: 5000, preBalances: [], postBalances: [] },
    transaction: {
      signatures: [receiptSignature],
      message: {
        accountKeys: [],
        recentBlockhash: web3.PublicKey.default.toBase58(),
        instructions: [
          {
            programId: new web3.PublicKey(config.programId),
            accounts: definition.accounts.map((account) =>
              account.name === "status"
                ? statusAddress(
                    new web3.PublicKey(config.programId),
                    parseSinkId(row.id),
                  )
                : web3.PublicKey.default,
            ),
            data: base58.encode(new Uint8Array(definition.discriminator)),
          },
        ],
      },
    },
  };
}

test("Solana links require the correct program, status PDA, instruction and finalized outcome slot", () => {
  const row: Transfer = {
    ...receiptTransfer(),
    solana: "minted",
    resolvedAtSlot: "1100",
  };
  const tx = resolutionFixture("mint_transfer");
  assert(isResolutionReceipt(tx, row, config.programId));
  assert(!isResolutionReceipt(tx, row, config.lightClientProgramId));
  assert(
    !isResolutionReceipt(
      tx,
      { ...row, id: `${receiptOwner}/100/2` },
      config.programId,
    ),
  );
  assert(
    !isResolutionReceipt(
      tx,
      { ...row, resolvedAtSlot: "1101" },
      config.programId,
    ),
  );
  assert(!isResolutionReceipt({ ...tx, meta: null }, row, config.programId));
  assert(
    !isResolutionReceipt(
      {
        ...tx,
        meta: {
          ...tx.meta,
          err: "failed",
          fee: 0,
          preBalances: [],
          postBalances: [],
        },
      },
      row,
      config.programId,
    ),
  );
  const voidTx = resolutionFixture("void_transfer");
  assert(!isResolutionReceipt(voidTx, row, config.programId));
  assert(
    isResolutionReceipt(voidTx, { ...row, solana: "voided" }, config.programId),
  );
  assert(
    isResolutionReceipt(tx, { ...row, solana: "voided" }, config.programId),
  );
});

test("receipt links arrive after an unavailable lookup, persist and do not repeat", () => {
  const s = state();
  s.snapshot = snapshot();
  const next = snapshot();
  next.transfers = [receiptTransfer()];
  updateTransfers(s, next, 1, config);
  assert(!s.outbox[0].text.includes("https://"));
  s.snapshot = next;
  s.outbox = [];
  const linked = structuredClone(next);
  linked.transfers[0].depositTxHash = "A".repeat(64);
  linked.transfers[0].solana = "minted";
  linked.transfers[0].resolvedAtSlot = "1100";
  linked.transfers[0].solanaTxSignature = receiptSignature;
  updateTransfers(s, linked, 2, config);
  const message = s.outbox[0].text;
  assert(
    message.includes(akashTxLink("A".repeat(64), config, "Original deposit")),
  );
  assert(message.includes(solanaTxLink(receiptSignature, config)));
  s.snapshot = linked;
  const restored = monitorStateSchema.parse(JSON.parse(JSON.stringify(s)));
  updateTransfers(restored, linked, 3, config);
  assert.equal(restored.outbox.length, 1);
  const incident: Alert = { ...critical, transferId: linked.transfers[0].id };
  assert(
    alertText(incident, config, restored).includes(
      solanaTxLink(receiptSignature, config),
    ),
  );
  const refunded = { ...linked.transfers[0], akash: "STATUS_REFUNDED" };
  assert.match(transferLinks(refunded, config), /Original deposit/);
  assert(!transferLinks(refunded, config).includes("Refund transaction"));
});

test("delayed receipt without a status change gets one follow-up notice", () => {
  const s = state();
  s.snapshot = snapshot();
  s.snapshot.transfers = [receiptTransfer()];
  const next = structuredClone(s.snapshot);
  next.transfers[0].depositTxHash = "B".repeat(64);
  updateTransfers(s, next, 1, config);
  assert.match(s.outbox[0].text, /Transfer receipts available/);
  s.snapshot = next;
  updateTransfers(s, next, 2, config);
  assert.equal(s.outbox.length, 1);
});

test("old persisted snapshots migrate without discarding accounting or inventing receipts", () => {
  const { burns, ...oldSnapshot } = snapshot();
  const { depositTxHash, solanaTxSignature, receiptCheckedAt, ...oldTransfer } =
    receiptTransfer();
  const restored = snapshotSchema.parse({
    ...oldSnapshot,
    transfers: [oldTransfer],
  });
  assert.equal(restored.transfers[0].depositTxHash, null);
  assert.equal(restored.transfers[0].solanaTxSignature, null);
  assert.deepEqual(restored.burns, []);
  assert.equal(restored.lockedUakt, oldSnapshot.lockedUakt);
});

test("explorer links reject malformed identifiers and never mislabel another chain as mainnet", () => {
  assert.throws(() => akashTxLink("<@everyone>", config));
  assert.throws(() => solanaTxLink("invalid", config));
  assert(
    !akashTxLink("A".repeat(64), {
      ...config,
      akashChainId: "testnet",
    }).includes("https://"),
  );
  assert(
    !solanaTxLink(receiptSignature, {
      ...config,
      solanaGenesis: "testnet",
    }).includes("https://"),
  );
});

test("burn links recover from persisted receipts even after the index advanced before a restart", async () => {
  await mkdir(".cache", { recursive: true });
  const directory = await mkdtemp(".cache/burn-receipts-");
  try {
    await mkdir(join(directory, "burn-events"));
    const burn = { signature: receiptSignature, slot: 1100, amount: "1000000" };
    await writeFile(
      join(directory, "burn-events", receiptSignature + ".json"),
      JSON.stringify(burn),
    );
    const previous = snapshot();
    const receipts = await burnReceipts(directory, previous, "1000000", 1200);
    assert.deepEqual(receipts, [burn]);
    const s = state();
    s.snapshot = previous;
    const next = {
      ...snapshot(),
      burnedUakt: "1000000",
      burns: receipts,
      solanaSlot: 1200,
    };
    updateTransfers(s, next, 1, config);
    assert(s.outbox[0].text.includes(solanaTxLink(receiptSignature, config)));
    assert.equal(
      (await burnReceipts(directory, next, "1000000", 1200)).length,
      0,
    );
    const missing = state();
    missing.snapshot = previous;
    updateTransfers(missing, { ...next, burns: [] }, 2, config);
    assert.match(missing.outbox[0].text, /Some burn receipts are missing/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("periodic summaries survive restarts and wait two hours after delivery", async () => {
  let s = state();
  s.snapshot = snapshot();
  const now = Date.parse(s.snapshot.checkedAt);
  queueSummary(s, config, now);
  assert.equal(s.outbox.length, 1);
  assert.match(s.outbox[0].text, /\*Light client\*\nActive/);
  const id = s.outbox[0].id;
  await assert.rejects(
    deliverOutbox({
      state: s,
      webhook: "https://hooks.slack.com/services/TEST",
      post: async () => new Response("invalid_token", { status: 400 }),
      persist: async () => {},
    }),
  );
  s = monitorStateSchema.parse(JSON.parse(JSON.stringify(s)));
  const later = now + 3 * 3600_000;
  queueSummary(s, config, later);
  assert.equal(s.outbox.length, 1);
  assert.equal(s.outbox[0].id, id);
  assert.match(s.outbox[0].text, /Updates unavailable/);
  assert.match(s.outbox[0].text, /last successful check/);
  let persisted = "";
  await deliverOutbox({
    state: s,
    webhook: "https://hooks.slack.com/services/TEST",
    post: async (_url, init) => {
      assert.match(String(init?.body), /Updates unavailable/);
      return new Response("ok");
    },
    persist: async () => {
      persisted = JSON.stringify(s);
    },
    now: () => later,
  });
  s = monitorStateSchema.parse(JSON.parse(persisted));
  queueSummary(s, config, later + 7200_000 - 1);
  assert.equal(s.outbox.length, 0);
  queueSummary(s, config, later + 7200_000);
  assert.equal(s.outbox.length, 1);
  assert.notEqual(s.outbox[0].id, id);
});

test("summary reports unknown observations and escapes untrusted alert text", () => {
  const s = state();
  s.active.example = { ...critical, title: "<@U123> & danger" };
  const text = summaryText(s, config, 0);
  assert.match(text, /Waiting for the first bridge check/);
  assert.match(text, /\*Open issues\*/);
  assert.match(text, /&lt;@U123&gt; &amp; danger/);
  assert(!text.includes("Light client: active"));
});

test("idle header lag is visible without treating normal inactivity as a failure", () => {
  const s = state();
  s.snapshot = snapshot();
  s.snapshot.akashHeight = 10000;
  s.snapshot.client.ageSeconds = 86400;
  assert.deepEqual(evaluate(s.snapshot, config), []);
  const text = summaryText(s, config, Date.parse(s.snapshot.checkedAt));
  assert.match(text, /header age 1d/);
  assert.match(text, /9,900 blocks behind/);
  s.snapshot.client.ageSeconds = s.snapshot.client.trustingPeriodSeconds / 4;
  assert.equal(
    evaluate(s.snapshot, config).find((a) => a.key === "client")?.severity,
    "warning",
  );
  s.snapshot.client.status = "expired";
  assert.equal(
    evaluate(s.snapshot, config).find((a) => a.key === "client")?.severity,
    "critical",
  );
});

test("reporter activity counts successful events, deduplicates members and expires old reports", () => {
  const alice = toBech32("akash", new Uint8Array(20).fill(1));
  const bob = toBech32("akash", new Uint8Array(20).fill(2));
  const retired = toBech32("akash", new Uint8Array(20).fill(3));
  const event = (reporter: string) => ({
    type: "akash.sink.v1.EventOutcomeReported",
    attributes: [{ key: "reporter", value: JSON.stringify(reporter) }],
  });
  const initial = recordReports(null, 10, 10000, [
    { code: 0, events: [event(alice), event(alice), event(retired)] },
    { code: 5, events: [event(bob)] },
  ]);
  assert.equal(Object.keys(initial.lastReportAt).length, 2);
  const s = state();
  s.snapshot = snapshot();
  s.snapshot.reporters = { version: "2", members: [alice, bob], quorum: 2 };
  s.snapshot.checkedAt = new Date(10000_000).toISOString();
  s.snapshot.akashHeight = 10;
  s.reporterActivity = initial;
  assert.deepEqual(reporterHealth(s, config, 10000_000), {
    authorized: 2,
    quorum: 2,
    recentlyReported: 1,
    coverageSeconds: 0,
    fresh: true,
    completeWindow: false,
  });
  s.reporterActivity = recordReports(initial, 20, 17201, []);
  s.snapshot.akashHeight = 20;
  s.snapshot.checkedAt = new Date(17201_000).toISOString();
  const health = reporterHealth(s, config, 17201_000);
  assert.equal(health.recentlyReported, 0);
  assert.equal(health.completeWindow, true);
  assert.equal(health.coverageSeconds, 7200);
  assert.equal(Object.keys(s.reporterActivity.lastReportAt).length, 0);
  s.snapshot.akashHeight = 21;
  assert.equal(reporterHealth(s, config, 17201_000).completeWindow, false);
  assert.match(summaryText(s, config, 17201_000), /history catching up/);
  assert.equal(
    reporterHealth(s, config, 17201_000 + config.staleSeconds * 1000).fresh,
    false,
  );
});

test("malformed successful report events fail closed instead of inventing an active reporter", () => {
  assert.throws(() =>
    recordReports(null, 10, 10000, [
      {
        code: 0,
        events: [
          { type: "akash.sink.v1.EventOutcomeReported", attributes: [] },
        ],
      },
    ]),
  );
  assert.throws(() =>
    recordReports(null, 10, 10000, [
      {
        code: 0,
        events: [
          {
            type: "akash.sink.v1.EventOutcomeReported",
            attributes: [{ key: "reporter", value: '"not-an-address"' }],
          },
        ],
      },
    ]),
  );
});

test("pre-summary saved state migrates without claiming an empty reporter policy", () => {
  const old = JSON.parse(JSON.stringify({ ...state(), snapshot: snapshot() }));
  delete old.reporterActivity;
  delete old.snapshot.reporters;
  const parsed = monitorStateSchema.parse(old);
  assert.equal(parsed.reporterActivity, null);
  assert.equal(parsed.snapshot?.reporters, null);
  assert.match(summaryText(parsed, config, 0), /Unknown authorized/);
});

test("Prometheus exposes header, client and reporter state without reporter address labels", () => {
  const s = state();
  s.snapshot = snapshot();
  s.snapshot.client.status = "frozen";
  s.snapshot.client.height = "90";
  s.snapshot.reporters = {
    version: "3",
    members: ["reporter-identity"],
    quorum: 1,
  };
  s.reporterActivity = {
    since: 1000,
    through: 8200,
    height: 100,
    lastReportAt: { "reporter-identity": 8199 },
  };
  s.snapshot.checkedAt = new Date(8200_000).toISOString();
  const text = metrics(s, true, config, 8200_000);
  assert.match(text, /akash_sink_client_status\{status="frozen"\} 1/);
  assert.match(text, /akash_sink_client_header_lag_blocks 10/);
  assert.match(text, /akash_sink_reporters_authorized 1/);
  assert.match(text, /akash_sink_reporters_recently_reported 1/);
  assert.match(text, /akash_sink_reporter_activity_fresh 1/);
  assert.match(text, /akash_sink_reporter_activity_coverage_seconds 7200/);
  assert.match(text, /akash_sink_monitor_summary_interval_seconds 7200/);
  assert(!text.includes("reporter-identity"));
});

test("a hung observation still delivers a due summary after immediate critical alerts", async () => {
  const s = state();
  s.snapshot = { ...snapshot(), checkedAt: new Date(0).toISOString() };
  updateAlerts(s, [critical], config, 0);
  let resolve: (() => void) | undefined;
  const observation = new Promise<void>((done) => {
    resolve = done;
  });
  const delivered: string[] = [];
  await withObservationWatchdog(
    observation,
    async () => {
      queueSummary(s, config, 7200_000);
      await deliverOutbox({
        state: s,
        webhook: "https://hooks.slack.com/services/TEST",
        post: async (_url, init) => {
          delivered.push(String(init?.body));
          return new Response("ok");
        },
        persist: async () => {},
        now: () => 7200_000,
      });
      resolve?.();
    },
    5,
  );
  assert.equal(delivered.length, 2);
  assert.match(delivered[0], /Backing mismatch/);
  assert.match(delivered[1], /Updates unavailable/);
  assert.match(delivered[1], /last successful check/);
  assert.equal(s.delivered.summary.sentAt, 7200_000);
});

test("startup is quiet until its grace period ends and suppresses empty summaries", () => {
  const s = state();
  observationUnavailable(s, config, config.startupGraceSeconds * 1000 - 1);
  queueSummary(s, config, config.startupGraceSeconds * 1000 - 1);
  assert.equal(s.outbox.length, 0);
  const alert = observationUnavailable(
    s,
    config,
    config.startupGraceSeconds * 1000,
  );
  queueSummary(s, config, config.startupGraceSeconds * 1000);
  assert.equal(alert?.severity, "critical");
  assert.equal(s.outbox.length, 1);
  assert.match(s.outbox[0].text, /couldn’t connect/);
  assert(!s.outbox[0].text.includes("Squad"));
  assert(!s.outbox[0].text.includes("backing deficit"));
});

test("brief RPC interruptions stay quiet, while stale observations still alert", () => {
  const s = state();
  s.snapshot = snapshot();
  const now = Date.parse(s.snapshot.checkedAt);
  observationUnavailable(s, config, now + config.staleSeconds * 1000 - 1);
  assert.equal(s.outbox.length, 0);
  const alert = observationUnavailable(
    s,
    config,
    now + config.staleSeconds * 1000,
  );
  assert.equal(alert?.severity, "critical");
  assert.match(s.outbox[0].text, /Bridge updates have stopped/);
});

test("first connection coalesces recovery and baseline into one useful update", async () => {
  const s = state();
  const initial = snapshot();
  const now = Date.parse(initial.checkedAt);
  observationUnavailable(s, config, now - 1000);
  await deliverOutbox({
    state: s,
    webhook: "https://hooks.slack.com/services/TEST",
    persist: async () => {},
    post: async () => new Response("ok"),
    now: () => now - 1000,
  });
  updateTransfers(s, initial, now, config);
  s.snapshot = initial;
  updateAlerts(s, [], config, now);
  queueSummary(s, config, now);
  assert.equal(s.outbox.length, 1);
  assert.equal(s.outbox[0].key, "summary");
  assert.match(s.outbox[0].text, /All clear/);
  assert.match(s.outbox[0].text, /\*Light client\*\n/);
  let deliveredId = "";
  await deliverOutbox({
    state: s,
    webhook: "https://hooks.slack.com/services/TEST",
    persist: async () => {},
    post: async (_url, init) => {
      const body = z
        .object({ text: z.string() })
        .parse(JSON.parse(String(init?.body)));
      deliveredId = s.outbox[0].id;
      assert(!body.text.includes(deliveredId));
      assert(!body.text.includes("Event ID"));
      assert(!body.text.includes("baseline"));
      assert(!body.text.includes("Slack queue"));
      assert(!body.text.includes(".000000"));
      return new Response("ok");
    },
    now: () => now,
  });
  assert.match(deliveredId, /^[a-f0-9]{64}$/);
  const restarted = monitorStateSchema.parse(JSON.parse(JSON.stringify(s)));
  queueSummary(restarted, config, now + 1);
  assert.equal(restarted.outbox.length, 0);
});

test("human-readable AKT amounts keep every micro-unit, including large balances", () => {
  assert.equal(formatAkt("13000000"), "13");
  assert.equal(formatAkt("1000001"), "1.000001");
  assert.equal(formatAkt("-1"), "-0.000001");
  assert.equal(formatAkt("9500000000000000001"), "9,500,000,000,000.000001");
});
