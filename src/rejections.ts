import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { decodeTxRaw } from "@cosmjs/proto-signing";
import { MsgSink } from "@akashnetwork/chain-sdk/private-types/akash.v1";
import { AkashClient } from "../vendor/akash";
const SINK_MSG_TYPE = "/akash.sink.v1.MsgSink";
import type { Config } from "./config";

export function rejectedDeposits(
  tx: Uint8Array,
  result: { code: number; codespace?: string },
) {
  if (result.code === 0) return [];
  const decoded = decodeTxRaw(tx);
  const hash = createHash("sha256").update(tx).digest("hex").toUpperCase();
  return decoded.body.messages
    .filter((message) => message.typeUrl === SINK_MSG_TYPE)
    .map((message) => {
      const deposit = MsgSink.decode(message.value);
      return {
        hash,
        code: result.code,
        codespace: result.codespace ?? "",
        sender: deposit.sender,
        recipient: deposit.dest,
        amount: deposit.amount?.amount ?? "unknown",
      };
    });
}

// Includes failed DeliverTx records even when they emitted no message events.
// Mempool rejection is not committed to chain and cannot be reconstructed here.
export async function scanRejections(
  config: Config,
  rpc: string,
  fromHeight: number,
  targetHeight: number,
) {
  const akash = new AkashClient(rpc, config.akashChainId, config.staleSeconds);
  const events: { id: string; at: string; detail: string; txHash: string }[] =
    [];
  try {
    if (fromHeight === 0) return { height: targetHeight, events };
    const end = Math.min(targetHeight, fromHeight + 200);
    const deadline = Date.now() + 20_000;
    let completed = fromHeight;
    for (let height = fromHeight + 1; height <= end; height++) {
      const [block, results] = await Promise.all([
        akash.comet.block(height),
        akash.comet.blockResults(height),
      ]);
      assert.equal(block.block.header.chainId, config.akashChainId);
      assert.equal(block.block.header.height, height);
      assert.equal(results.height, height);
      assert.equal(block.block.txs.length, results.results.length);
      for (const [index, tx] of block.block.txs.entries()) {
        for (const rejection of rejectedDeposits(tx, results.results[index])) {
          events.push({
            id: "rejection-" + rejection.hash,
            txHash: rejection.hash,
            at: block.block.header.time.toISOString(),
            detail: `Akash deposit rejected in block ${height}; tx ${rejection.hash}; sender ${rejection.sender}; recipient ${rejection.recipient}; ${rejection.amount} uakt; ${rejection.codespace}/${rejection.code}. No bridge deposit was created by this failed transaction.`,
          });
        }
      }
      completed = height;
      if (Date.now() >= deadline) break;
    }
    return { height: completed, events };
  } finally {
    akash.close();
  }
}
