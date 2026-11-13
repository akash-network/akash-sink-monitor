// Adapted from akash-network/node 4373aa92; see vendor/README.md and NODE-LICENSE.
import { Sink_Status as Status } from "@akashnetwork/chain-sdk/private-types/akash.v1";
import { Program, utils, web3 } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, unpackMint } from "@solana/spl-token";
import {
  QueryBalanceRequest,
  QueryBalanceResponse,
} from "cosmjs-types/cosmos/bank/v1beta1/query";
import assert from "node:assert/strict";
import { toBech32 } from "@cosmjs/encoding";
import { createHash } from "node:crypto";
import { join } from "node:path";
import idl from "../idl/akt.json";
import type { Akt } from "../idl/akt";
import { AkashClient } from "./akash";
import { minimumSlot } from "./reporter-policy";
import { decodeRecord } from "./proof";
import { coinAmount, matchesAnchorId, statusAddress } from "./proof";
import { object, pda } from "./common";
import { atomicJson, optionalJson } from "./durable";
import { collectPages } from "./open-transfers";
import { inSnapshot, transferAlerts } from "./reconcile-policy";

function amount(value: unknown) {
  assert.ok(
    typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value),
    "invalid amount",
  );
  return BigInt(value);
}

type Resolution =
  | { solana: "pending"; resolvedAtSlot: null }
  | { solana: "minted" | "voided"; resolvedAtSlot: bigint };

function resolutionAtSnapshot(input: {
  program: Program<Akt>;
  record: ReturnType<typeof decodeRecord>;
  info: web3.AccountInfo<Buffer> | null;
  slot: number;
}): Resolution {
  const { program, record, info, slot } = input;
  if (!info) return { solana: "pending", resolvedAtSlot: null };
  assert.ok(info.owner.equals(program.programId) && !info.executable);
  const status = program.coder.accounts.decode<
    Awaited<ReturnType<typeof program.account.transferStatus.fetch>>
  >("transferStatus", info.data);
  assert.ok(matchesAnchorId(status.id, record.id), "status identity mismatch");
  assert.ok(
    BigInt(status.proofHeight.toString()) > record.height,
    "proof predates deposit",
  );
  const resolvedAtSlot = BigInt(status.resolvedAtSlot.toString());
  if (!inSnapshot(resolvedAtSlot, slot))
    return { solana: "pending", resolvedAtSlot: null };
  if (status.outcome.minted) {
    assert.equal(
      BigInt(status.outcome.minted.amount.toString()),
      record.amount,
    );
    assert.ok(status.outcome.minted.recipient.equals(record.recipient));
    return { solana: "minted", resolvedAtSlot };
  }
  return { solana: "voided", resolvedAtSlot };
}

// Burn accounting comes from successful finalized SPL instructions, including
// inner CPI calls. It is independent of the supply difference being checked.
async function indexBurns(
  connection: web3.Connection,
  mint: web3.PublicKey,
  slot: number,
  root: string,
  programId: web3.PublicKey,
) {
  const path = join(root, "burn-index.json");
  const genesis = await connection.getGenesisHash();
  const saved = await optionalJson(path);
  const prior = saved === undefined ? undefined : object(saved);
  if (prior) {
    assert.equal(prior.genesis, genesis);
    assert.equal(prior.mint, mint.toBase58());
    assert.ok(
      typeof prior.slot === "number" &&
        Number.isSafeInteger(prior.slot) &&
        prior.slot <= slot,
      "invalid burn checkpoint slot",
    );
    assert.ok(
      typeof prior.cursor === "string" &&
        typeof prior.genesisTransaction === "string",
    );
  }
  let burned = prior ? amount(prior.burned) : 0n;
  let genesisTransaction = prior?.genesisTransaction;
  let before: string | undefined;
  const assertHistoryCoverage = async () => {
    if (prior) {
      assert.ok(typeof prior.slot === "number");
      assert.ok(
        (await connection.getFirstAvailableBlock()) <= prior.slot + 1,
        "burn checkpoint predates retained RPC history; refusing a gap",
      );
    }
  };
  await assertHistoryCoverage();
  let reachedCursor = false;
  const signatures: web3.ConfirmedSignatureInfo[] = [];
  for (let page = 0; ; page++) {
    assert.ok(
      page < 100,
      "burn history exceeds local 10000-transaction scan bound",
    );
    const rows = await connection.getSignaturesForAddress(
      mint,
      { before, limit: 100 },
      "finalized",
    );
    if (!rows.length) break;
    for (const row of rows) {
      if (prior && typeof prior.slot === "number" && row.slot <= prior.slot) {
        reachedCursor = true;
        break;
      }
      if (row.slot <= slot) signatures.push(row);
    }
    if (reachedCursor) break;
    before = rows.at(-1)?.signature;
  }
  // A quiet mint's last signature may be pruned before the index checkpoint.
  // Coverage is anchored to the finalized slot already scanned, not that old
  // signature. No newer row is also a valid scan, while the slot range exists.
  await assertHistoryCoverage();
  const burns: { signature: string; slot: number; amount: string }[] = [];
  const initialize = createHash("sha256")
    .update("global:initialize")
    .digest()
    .subarray(0, 8);
  for (const row of signatures) {
    if (row.err) continue;
    // Holders' wallets send version 1 transactions (SIMD-0385).
    const tx = await connection.getParsedTransaction(row.signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 1,
    });
    assert.ok(
      tx?.meta && tx.slot === row.slot && tx.meta.err === null,
      "finalized transaction history unavailable",
    );
    const instructions = [
      ...tx.transaction.message.instructions,
      ...(tx.meta.innerInstructions ?? []).flatMap((i) => i.instructions),
    ];
    let burnedHere = 0n;
    // Genesis mints nothing; its initialize transaction, which creates the
    // mint, anchors the start of the burn history.
    const initializes = tx.transaction.message.instructions.some(
      (ix) =>
        ix.programId.equals(programId) &&
        "data" in ix &&
        Buffer.from(utils.bytes.bs58.decode(ix.data))
          .subarray(0, 8)
          .equals(initialize) &&
        ix.accounts.some((a) => a.equals(mint)),
    );
    for (const ix of instructions) {
      if (!ix.programId.equals(TOKEN_PROGRAM_ID) || !("parsed" in ix)) continue;
      const parsed = object(ix.parsed);
      const info = object(parsed.info);
      if (info.mint !== mint.toBase58()) continue;
      if (parsed.type === "burn") burnedHere += amount(info.amount);
      else if (parsed.type === "burnChecked")
        burnedHere += amount(object(info.tokenAmount).amount);
    }
    if (initializes) genesisTransaction = row.signature;
    if (burnedHere > 0n) {
      burned += burnedHere;
      burns.push({
        signature: row.signature,
        slot: row.slot,
        amount: burnedHere.toString(),
      });
    }
  }
  assert.ok(
    typeof genesisTransaction === "string",
    "mint genesis transaction missing; refusing an incomplete burn baseline",
  );
  const cursor = signatures[0]?.signature ?? prior?.cursor;
  assert.ok(typeof cursor === "string");
  await assertHistoryCoverage();
  const next = {
    version: 1,
    genesis,
    mint: mint.toBase58(),
    cursor,
    slot,
    burned: burned.toString(),
    genesisTransaction,
  };
  // Write idempotent evidence before advancing the cursor. A crash can repeat a
  // write, but cannot permanently omit an event from the audit trail.
  for (const burn of burns)
    await atomicJson(join(root, "burn-events", `${burn.signature}.json`), burn);
  await atomicJson(path, next);
  return next;
}

// Supply only public identities and a read-only connection.
export async function reconcileConfigured(input: {
  connection: web3.Connection;
  programId: web3.PublicKey;
  akashRpc: string;
  chainId: string;
  stateDir: string;
  reportLagSeconds: number;
}) {
  const { connection, programId, stateDir, reportLagSeconds } = input;
  const program = new Program<Akt>(
    { ...idl, address: programId.toBase58() },
    { connection },
  );
  const akash = new AkashClient(input.akashRpc, input.chainId, 60);
  try {
    const state = await akash.state();
    const records = (
      await collectPages((key) =>
        akash.transfers(state.height, { key, limit: 500 }),
      )
    ).map(({ transfer }) => ({ transfer, record: decodeRecord(transfer) }));
    const mint = pda("mint", programId);
    const addresses = [
      mint,
      ...records.map(({ record }) => statusAddress(programId, record.id)),
    ];
    // The first page pins the finalized slot for supply. Later pages may come
    // from a newer slot; statuses resolved after the pinned slot are excluded.
    const snapshot = await connection.getMultipleAccountsInfoAndContext(
      addresses.slice(0, 100),
      {
        commitment: "finalized",
        minContextSlot: Number(
          records.reduce((slot, { transfer }) => {
            const reported = minimumSlot(transfer);
            return reported > slot ? reported : slot;
          }, 0n),
        ),
      },
    );
    const infos = [...snapshot.value];
    for (let i = 100; i < addresses.length; i += 100) {
      const page = await connection.getMultipleAccountsInfoAndContext(
        addresses.slice(i, i + 100),
        { commitment: "finalized", minContextSlot: snapshot.context.slot },
      );
      assert.ok(page.context.slot >= snapshot.context.slot);
      infos.push(...page.value);
    }
    // Later deposits can be left to the next poll unless they already minted
    // at the pinned supply slot. Only that case invalidates this backing set.
    const freshState = await akash.state();
    assert.ok(freshState.height >= state.height, "Akash snapshot regressed");
    const freshHistory = await collectPages((key) =>
      akash.transfers(freshState.height, { key, limit: 500 }),
    );
    const knownIds = new Set(records.map(({ record }) => record.id));
    assert.deepEqual(
      freshHistory
        .filter((entry) => knownIds.has(entry.id))
        .map((entry) => entry.id),
      records.map((entry) => entry.record.id),
      "transfer history disappeared or reordered during reconciliation",
    );
    const arrivals = freshHistory
      .filter((entry) => !knownIds.has(entry.id))
      .map(({ transfer }) => decodeRecord(transfer));
    for (const record of arrivals)
      assert.ok(
        record.height > BigInt(state.height),
        "earlier deposit missing from snapshot",
      );
    for (let i = 0; i < arrivals.length; i += 100) {
      const batch = arrivals.slice(i, i + 100);
      const page = await connection.getMultipleAccountsInfoAndContext(
        batch.map((record) => statusAddress(programId, record.id)),
        { commitment: "finalized", minContextSlot: snapshot.context.slot },
      );
      assert.ok(page.context.slot >= snapshot.context.slot);
      assert.equal(
        page.value.length,
        batch.length,
        "incomplete new-deposit status page",
      );
      for (const [index, record] of batch.entries())
        assert.notEqual(
          resolutionAtSnapshot({
            program,
            record,
            info: page.value[index],
            slot: snapshot.context.slot,
          }).solana,
          "minted",
          "new deposit already minted at snapshot slot; retry snapshot",
        );
    }
    const mintInfo = unpackMint(mint, infos[0], TOKEN_PROGRAM_ID);
    assert.equal(mintInfo.decimals, 6);
    assert.equal(mintInfo.freezeAuthority, null);
    assert.ok(mintInfo.mintAuthority?.equals(pda("mint_authority", programId)));
    let observedMinted = 0n;
    let awaitingReports = 0n;
    let pendingUnminted = 0n;
    const alerts: string[] = [];
    const outcomes: {
      id: string;
      amountUakt: string;
      recipient: string;
      solana: "pending" | "minted" | "voided";
      resolvedAtSlot: string | null;
    }[] = [];
    for (const [i, { transfer, record }] of records.entries()) {
      const info = infos[i + 1];
      const settlement = transfer.settlement;
      assert.ok(settlement);
      const resolution = resolutionAtSnapshot({
        program,
        record,
        info,
        slot: snapshot.context.slot,
      });
      const solana =
        resolution.solana === "pending" ? undefined : resolution.solana;
      const resolvedAtSlot = resolution.resolvedAtSlot ?? undefined;
      if (solana === "minted") {
        observedMinted += record.amount;
        if (
          transfer.status === Status.STATUS_TRANSFER_PENDING ||
          transfer.status === Status.STATUS_VOIDED
        )
          awaitingReports += record.amount;
      }
      if (
        solana !== "minted" &&
        (transfer.status === Status.STATUS_TRANSFER_PENDING ||
          transfer.status === Status.STATUS_VOIDED)
      )
        pendingUnminted += record.amount;
      outcomes.push({
        id: record.id,
        amountUakt: record.amount.toString(),
        recipient: record.recipient.toBase58(),
        solana: solana ?? "pending",
        resolvedAtSlot: resolvedAtSlot?.toString() ?? null,
      });
      alerts.push(
        ...transferAlerts({
          id: record.id,
          akash: transfer.status,
          hold: settlement.hold,
          solana,
          resolvedAtSlot,
          slot: snapshot.context.slot,
          reportLagSeconds,
        }),
      );
    }
    const sinkAddress = toBech32(
      "akash",
      createHash("sha256").update("sink").digest().subarray(0, 20),
    );
    const balanceReply = await akash.comet.abciQuery({
      path: "/cosmos.bank.v1beta1.Query/Balance",
      data: QueryBalanceRequest.encode({
        address: sinkAddress,
        denom: "uakt",
      }).finish(),
      height: state.height,
    });
    assert.equal(balanceReply.code, 0);
    assert.equal(balanceReply.height, state.height);
    const balance = BigInt(
      QueryBalanceResponse.decode(balanceReply.value).balance?.amount ?? "0",
    );
    const accounted =
      coinAmount(state.totals.pendingAmount) +
      coinAmount(state.totals.mintedAmount) +
      coinAmount(state.totals.voidedAmount) +
      coinAmount(state.totals.refundPendingAmount);
    if (balance !== accounted)
      alerts.push("Akash bank escrow differs from sink totals");
    const burnIndex = await indexBurns(
      connection,
      mint,
      snapshot.context.slot,
      stateDir,
      programId,
    );
    // Every SPL AKT was minted for a proven record whose escrow stays locked
    // on Akash: supply plus burns equals the escrow behind Minted records.
    const backing = observedMinted;
    const supplyAndBurns = mintInfo.supply + BigInt(burnIndex.burned);
    if (backing !== supplyAndBurns)
      alerts.push(
        `backing minus supply and burns: ${backing - supplyAndBurns} uakt`,
      );
    const report = {
      checkedAt: new Date().toISOString(),
      chainId: input.chainId,
      genesis: burnIndex.genesis,
      status: alerts.length ? "mismatch" : "healthy",
      akashHeight: state.height,
      solanaSlot: snapshot.context.slot,
      lockedUakt: balance.toString(),
      accountedEscrowUakt: accounted.toString(),
      observedMintedUakt: observedMinted.toString(),
      solanaSupplyUakt: mintInfo.supply.toString(),
      cumulativeBurnedUakt: burnIndex.burned,
      awaitingMintReportsUakt: awaitingReports.toString(),
      pendingUnmintedUakt: pendingUnminted.toString(),
      voidRequestedEscrowUakt: coinAmount(state.totals.voidedAmount).toString(),
      voidedEscrowUakt: coinAmount(state.totals.refundPendingAmount).toString(),
      alerts,
    };
    await atomicJson(join(stateDir, "reconciliation.json"), report);
    return { report, state, records, outcomes };
  } finally {
    akash.close();
  }
}
