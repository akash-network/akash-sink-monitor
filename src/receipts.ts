import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { web3 } from "@coral-xyz/anchor";
import { base58 } from "@scure/base";
import { decodeTxRaw } from "@cosmjs/proto-signing";
import {
  Comet38Client,
  HttpClient,
  type comet38,
} from "@cosmjs/tendermint-rpc";
import { TxMsgData } from "cosmjs-types/cosmos/base/abci/v1beta1/abci";
import {
  DestType,
  MsgSink,
  MsgSinkResponse,
} from "@akashnetwork/chain-sdk/private-types/akash.v1";
import idl from "../idl/akt.json";
import { parseSinkId, sinkIdParts } from "../vendor/id";
import { statusAddress } from "../vendor/proof";
import { burnSchema, type Snapshot, type Transfer } from "./model";
import type { Config } from "./config";

// Bind the signed deposit and its response ID to the reconciled transfer.
export function depositReceipt(
  bytes: Uint8Array,
  result: Pick<comet38.TxResponse["result"], "code" | "data">,
  transfer: Transfer,
): string | null {
  if (result.code !== 0) return null;
  try {
    const messages = decodeTxRaw(bytes).body.messages;
    const responses = TxMsgData.decode(
      result.data ?? new Uint8Array(),
    ).msgResponses;
    if (messages.length !== responses.length) return null;
    for (const [index, message] of messages.entries()) {
      const response = responses[index];
      if (
        message.typeUrl !== "/akash.sink.v1.MsgSink" ||
        response.typeUrl !== "/akash.sink.v1.MsgSinkResponse"
      )
        continue;
      const deposit = MsgSink.decode(message.value);
      const id = parseSinkId(MsgSinkResponse.decode(response.value).id);
      if (
        id === transfer.id &&
        sinkIdParts(id).owner === deposit.sender &&
        deposit.sender === transfer.owner &&
        deposit.dest === transfer.recipient &&
        deposit.destType === DestType.DEST_TYPE_SOLANA &&
        deposit.amount?.denom === "uakt" &&
        deposit.amount.amount === transfer.amountUakt
      )
        return createHash("sha256").update(bytes).digest("hex").toUpperCase();
    }
  } catch {
    return null;
  }
  return null;
}

export async function depositHash(
  comet: Comet38Client,
  transfer: Transfer,
  chainId: string,
) {
  const height = Number(sinkIdParts(parseSinkId(transfer.id)).height);
  assert(Number.isSafeInteger(height));
  const [block, results] = await Promise.all([
    comet.block(height),
    comet.blockResults(height),
  ]);
  assert.equal(block.block.header.chainId, chainId);
  assert.equal(block.block.header.height, height);
  assert.equal(results.height, height);
  assert.equal(block.block.txs.length, results.results.length);
  for (const [index, bytes] of block.block.txs.entries()) {
    const hash = depositReceipt(bytes, results.results[index], transfer);
    if (hash) return hash;
  }
  return null;
}

export function isResolutionReceipt(
  tx: web3.ParsedTransactionWithMeta,
  transfer: Transfer,
  programId: string,
): boolean {
  if (
    !tx.meta ||
    tx.meta.err !== null ||
    String(tx.slot) !== transfer.resolvedAtSlot ||
    transfer.solana === "pending"
  )
    return false;
  const program = new web3.PublicKey(programId);
  const status = statusAddress(program, parseSinkId(transfer.id));
  return tx.transaction.message.instructions.some((instruction) => {
    if (!instruction.programId.equals(program) || !("data" in instruction))
      return false;
    const data = base58.decode(instruction.data);
    return idl.instructions.some((definition) => {
      if (
        definition.name !== "mint_transfer" &&
        !(transfer.solana === "voided" && definition.name === "void_transfer")
      )
        return false;
      const statusIndex = definition.accounts.findIndex(
        (account) => account.name === "status",
      );
      return (
        instruction.accounts[statusIndex]?.equals(status) &&
        Buffer.from(data.subarray(0, 8)).equals(
          Buffer.from(definition.discriminator),
        )
      );
    });
  });
}

async function resolutionSignature(
  connection: web3.Connection,
  transfer: Transfer,
  programId: string,
) {
  const address = statusAddress(
    new web3.PublicKey(programId),
    parseSinkId(transfer.id),
  );
  let before: string | undefined;
  for (let page = 0; page < 3; page++) {
    const rows = await connection.getSignaturesForAddress(
      address,
      { before, limit: 100 },
      "finalized",
    );
    for (const row of rows) {
      if (BigInt(row.slot) < BigInt(transfer.resolvedAtSlot ?? "0"))
        return null;
      if (row.err || String(row.slot) !== transfer.resolvedAtSlot) continue;
      const tx = await connection.getParsedTransaction(row.signature, {
        commitment: "finalized",
        maxSupportedTransactionVersion: 1,
      });
      if (
        tx?.transaction.signatures[0] === row.signature &&
        isResolutionReceipt(tx, transfer, programId)
      )
        return row.signature;
    }
    if (rows.length < 100) break;
    before = rows.at(-1)?.signature;
  }
  return null;
}

// Receipt history is optional tracing evidence. Accounting still uses verified
// state even if this bounded lookup fails; missing links retry on later polls.
export async function enrichReceipts(
  transfers: Transfer[],
  config: Config,
  akashRpc: string,
  solanaRpc: string,
) {
  const deadline = Date.now() + 15_000;
  const signal = AbortSignal.timeout(15_000);
  const comet = Comet38Client.create(new HttpClient(akashRpc, 3000));
  const connection = new web3.Connection(solanaRpc, {
    commitment: "finalized",
    disableRetryOnRateLimit: true,
    fetch: (url, options) =>
      fetch(url, {
        ...options,
        signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
      }),
  });
  let attempts = 0;
  try {
    for (const transfer of [...transfers].sort(
      (a, b) =>
        a.receiptCheckedAt - b.receiptCheckedAt ||
        b.depositedAt - a.depositedAt,
    )) {
      if (Date.now() >= deadline || attempts >= 10) break;
      transfer.receiptCheckedAt = Date.now();
      if (!transfer.depositTxHash) {
        attempts++;
        transfer.depositTxHash = await depositHash(
          comet,
          transfer,
          config.akashChainId,
        ).catch(() => null);
      }
      if (Date.now() >= deadline || attempts >= 10) break;
      if (transfer.solana !== "pending" && !transfer.solanaTxSignature) {
        attempts++;
        transfer.solanaTxSignature = await resolutionSignature(
          connection,
          transfer,
          config.programId,
        ).catch(() => null);
      }
    }
  } finally {
    comet.disconnect();
  }
}

export async function burnReceipts(
  stateDir: string,
  previous: Snapshot | null,
  burnedUakt: string,
  slot: number,
): Promise<Snapshot["burns"]> {
  if (!previous || BigInt(burnedUakt) <= BigInt(previous.burnedUakt)) return [];
  const directory = join(stateDir, "burn-events");
  const receipts: Snapshot["burns"] = [];
  try {
    for (const filename of await readdir(directory)) {
      if (!filename.endsWith(".json")) continue;
      const receipt = burnSchema.parse(
        JSON.parse(await readFile(join(directory, filename), "utf8")),
      );
      if (filename !== receipt.signature + ".json") continue;
      if (receipt.slot > previous.solanaSlot && receipt.slot <= slot)
        receipts.push(receipt);
    }
  } catch {
    // The cumulative burn index remains authoritative; alerts explicitly mark
    // unavailable transaction receipts rather than inventing a transaction.
    return [];
  }
  return receipts.sort((a, b) => a.slot - b.slot);
}
