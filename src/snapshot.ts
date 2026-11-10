import assert from "node:assert/strict";
import { Program, web3, type IdlAccounts } from "@coral-xyz/anchor";
import {
  Hold,
  Sink_Status as Status,
} from "@akashnetwork/chain-sdk/private-types/akash.v1";
import idl from "../idl/akt.json";
import type { Akt } from "../idl/akt";
import clientIdl from "../idl/ics07_tendermint.json";
import type { Ics07Tendermint } from "../idl/ics07_tendermint";
import { AkashClient } from "../vendor/akash";
import { reporterThreshold } from "../vendor/reporter-policy";
import { coinAmount } from "../vendor/proof";
import { sinkIdParts } from "../vendor/id";
import { pda, LE64 } from "../vendor/common";
import { clientStatus } from "../vendor/client-status";
import { reconcileConfigured } from "../vendor/reconcile";
import type { Config } from "./config";
import {
  snapshotSchema,
  type Snapshot,
  type Cap,
  type Transfer,
} from "./model";
import { burnReceipts, enrichReceipts } from "./receipts";

export async function collectSnapshot(
  config: Config,
  connection: web3.Connection,
  akashRpc: string,
  previous: Snapshot | null,
): Promise<Snapshot> {
  assert.equal(
    await connection.getGenesisHash(),
    config.solanaGenesis,
    "wrong Solana genesis",
  );
  const programId = new web3.PublicKey(config.programId);
  const mint = pda("mint", programId);
  assert.equal(mint.toBase58(), config.mint, "wrong canonical mint");
  const program = new Program<Akt>(
    { ...idl, address: config.programId },
    { connection },
  );
  const observed = await connection.getMultipleAccountsInfoAndContext(
    [
      programId,
      pda("config", programId),
      pda("bridge", programId),
      pda("guardian", programId),
      web3.SYSVAR_CLOCK_PUBKEY,
    ],
    { commitment: "finalized" },
  );
  const [executable, launchAccount, bridgeAccount, guardianAccount, clock] =
    observed.value;
  assert(executable?.executable, "AKT program unavailable");
  assert(
    launchAccount && bridgeAccount && guardianAccount,
    "bridge configuration unavailable",
  );
  for (const account of [launchAccount, bridgeAccount, guardianAccount]) {
    assert(
      account.owner.equals(programId) && !account.executable,
      "wrong bridge account owner",
    );
  }
  assert(clock && clock.data.length === 40, "Solana Clock unavailable");
  const solanaTime = Number(clock.data.readBigInt64LE(32));
  assert(
    Math.abs(Date.now() / 1000 - solanaTime) <= config.staleSeconds,
    "stale Solana Clock",
  );
  const launch = program.coder.accounts.decode<
    IdlAccounts<Akt>["launchConfig"]
  >("launchConfig", launchAccount.data);
  const bridge = program.coder.accounts.decode<
    IdlAccounts<Akt>["bridgeConfig"]
  >("bridgeConfig", bridgeAccount.data);
  assert(
    BigInt(Math.floor(solanaTime / 86400)) >= BigInt(bridge.mintDay.toString()),
    "Solana mint day is in the future",
  );
  const guardian = program.coder.accounts.decode<
    IdlAccounts<Akt>["pauseGuardian"]
  >("pauseGuardian", guardianAccount.data);
  assert.equal(launch.version, 2, "unsupported launch version");
  assert(launch.mint.equals(mint), "wrong launch mint");
  assert.equal(bridge.chainId, config.akashChainId, "wrong bridge origin");
  const client = new Program<Ics07Tendermint>(
    { ...clientIdl, address: bridge.lightClientProgram.toBase58() },
    { connection },
  );
  const clientState = await client.account.clientState.fetch(
    pda("client", client.programId),
    "finalized",
  );
  assert.equal(
    clientState.chainId,
    config.akashChainId,
    "wrong light-client chain",
  );
  const height = BigInt(clientState.latestHeight.revisionHeight.toString());
  const consensus = await client.account.consensusStateStore.fetch(
    pda("consensus_state", client.programId, LE64(height)),
    "finalized",
  );
  const consensusTime = BigInt(consensus.consensusState.timestamp.toString());
  const trustingPeriod = BigInt(clientState.trustingPeriod.toString());
  const result = await reconcileConfigured({
    connection,
    programId,
    akashRpc,
    chainId: config.akashChainId,
    stateDir: config.stateDir,
    reportLagSeconds: config.reportLagSeconds,
  });
  const { state, report } = result;
  const akash = new AkashClient(
    akashRpc,
    config.akashChainId,
    config.staleSeconds,
  );
  try {
    const owners = new Set(
      result.records.map(({ record }) => sinkIdParts(record.id).owner),
    );
    const caps: Cap[] = [
      {
        key: "akash-send",
        label: "Akash deposits",
        usedUakt: coinAmount(state.sendUsage.amount).toString(),
        limitUakt: coinAmount(
          state.params.maxTransferAmountPerEpoch,
        ).toString(),
        period: "Native Akash day epoch " + state.epoch,
      },
      {
        key: "akash-refund",
        label: "Akash refunds",
        usedUakt: coinAmount(state.refundUsage.amount).toString(),
        limitUakt: coinAmount(state.params.maxEpochRefund).toString(),
        period: "Native Akash day epoch " + state.epoch,
      },
      {
        key: "solana-mint",
        label: "Solana mints",
        usedUakt:
          BigInt(bridge.mintDay.toString()) ===
          BigInt(Math.floor(solanaTime / 86400))
            ? bridge.mintedToday.toString()
            : "0",
        limitUakt: bridge.policy.dailyMintCap.toString(),
        period: "Solana UTC mint day " + Math.floor(solanaTime / 86400),
      },
    ];
    for (const owner of owners) {
      const account = await akash.account(owner, state.height);
      assert(
        account.usage && account.epoch === state.epoch,
        "account quota epoch mismatch",
      );
      caps.push({
        key: "account:" + owner,
        label: "Account " + owner,
        usedUakt: coinAmount(account.usage.epochSent).toString(),
        limitUakt: coinAmount(state.params.maxEpochAmountPerAccount).toString(),
        period: "Native Akash day epoch " + state.epoch,
      });
    }
    const blockTimes = new Map<string, number>();
    const previousById = new Map(
      previous?.transfers.map((row) => [row.id, row]),
    );
    const transfers: Transfer[] = [];
    let deposited = 0n,
      largestPending = 0n;
    for (const [index, entry] of result.records.entries()) {
      const { record, transfer } = entry;
      const outcome = result.outcomes[index];
      assert.equal(outcome.id, record.id);
      assert(transfer.settlement?.policy, "missing transfer reporter policy");
      const old = previousById.get(record.id);
      let depositedAt =
        old?.depositedAt ?? blockTimes.get(record.height.toString());
      if (depositedAt === undefined) {
        const block = await akash.comet.block(Number(record.height));
        assert.equal(block.block.header.chainId, config.akashChainId);
        assert.equal(block.block.header.height, Number(record.height));
        depositedAt = Math.floor(block.block.header.time.getTime() / 1000);
        blockTimes.set(record.height.toString(), depositedAt);
      }
      deposited += record.amount;
      if (
        outcome.solana === "pending" &&
        transfer.status === Status.STATUS_TRANSFER_PENDING &&
        record.amount > largestPending
      )
        largestPending = record.amount;
      transfers.push({
        ...outcome,
        owner: sinkIdParts(record.id).owner,
        depositedAt,
        resolvedObservedAt:
          outcome.solana === "pending"
            ? null
            : (old?.resolvedObservedAt ?? Number(state.time)),
        akash: Status[transfer.status],
        hold: Hold[transfer.settlement.hold],
        challengeEnd: transfer.settlement.challengeEnd.toString(),
        votes: transfer.settlement.votes.length,
        quorum: reporterThreshold(
          transfer.settlement.policy.threshold,
          transfer.settlement.policy.members.length,
        ),
        vetoReason: transfer.settlement.vetoReason,
        depositTxHash: old?.depositTxHash ?? null,
        solanaTxSignature: old?.solanaTxSignature ?? null,
        receiptCheckedAt: old?.receiptCheckedAt ?? 0,
      });
    }
    caps.push(
      {
        key: "akash-transfer",
        label: "Largest queued transfer / Akash per-transfer limit",
        usedUakt: largestPending.toString(),
        limitUakt: coinAmount(state.params.maxAmountPerTransfer).toString(),
        period: "Per transfer; not a cumulative quota",
      },
      {
        key: "solana-transfer",
        label: "Largest queued transfer / Solana per-transfer limit",
        usedUakt: largestPending.toString(),
        limitUakt: bridge.policy.perTransferMax.toString(),
        period: "Per transfer; not a cumulative quota",
      },
    );
    await enrichReceipts(transfers, config, akashRpc, connection.rpcEndpoint);
    const burns = await burnReceipts(
      config.stateDir,
      previous,
      report.cumulativeBurnedUakt,
      report.solanaSlot,
    );
    assert(
      Date.now() / 1000 - Number(state.time) <= config.staleSeconds,
      "Akash snapshot expired during collection",
    );
    assert(
      Date.now() / 1000 - solanaTime <= config.staleSeconds,
      "Solana snapshot expired during collection",
    );
    return snapshotSchema.parse({
      checkedAt: new Date().toISOString(),
      akashHeight: state.height,
      solanaSlot: report.solanaSlot,
      akashTime: Number(state.time),
      solanaTime,
      lockedUakt: report.lockedUakt,
      accountedEscrowUakt: report.accountedEscrowUakt,
      mintedUakt: report.observedMintedUakt,
      supplyUakt: report.solanaSupplyUakt,
      burnedUakt: report.cumulativeBurnedUakt,
      depositedUakt: deposited.toString(),
      refundedUakt: coinAmount(state.totals.refundedAmount).toString(),
      awaitingReportsUakt: report.awaitingMintReportsUakt,
      pendingUakt: report.pendingUnmintedUakt,
      refundPendingUakt: report.voidedEscrowUakt,
      depositsEnabled: state.params.enabled,
      refundsEnabled: state.params.refundsEnabled,
      mintingEnabled: launch.bridgeEnabled,
      guardian: guardian.guardian?.toBase58() ?? null,
      nativeGuardian: state.params.pauseGuardian,
      reporters: {
        version: state.policy.version.toString(),
        members: state.policy.members,
        quorum: reporterThreshold(
          state.policy.threshold,
          state.policy.members.length,
        ),
      },
      client: {
        program: client.programId.toBase58(),
        height: height.toString(),
        ageSeconds: solanaTime - Number(consensusTime / 1_000_000_000n),
        trustingPeriodSeconds: Number(trustingPeriod),
        status: clientStatus({
          frozenHeight: BigInt(
            clientState.frozenHeight.revisionHeight.toString(),
          ),
          consensusTimestampNs: consensusTime,
          trustingPeriodSeconds: trustingPeriod,
          solanaTimeSeconds: BigInt(solanaTime),
        }),
      },
      caps,
      transfers,
      burns,
    });
  } finally {
    akash.close();
  }
}
