// Adapted from akash-network/node 4373aa92; see vendor/README.md and NODE-LICENSE.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { BN, web3 } from "@coral-xyz/anchor";
import type {
  RecordData,
  TransferState,
} from "@akashnetwork/chain-sdk/private-types/akash.v1";
import {
  MAX_UINT64,
  ownerBytes,
  parseSinkId,
  sinkIdParts,
  type SinkId,
} from "./id";
const proofNonce = (key: Uint8Array) =>
  createHash("sha256").update(key).digest();
export function anchorId(id: SinkId) {
  const value = sinkIdParts(id);
  return {
    owner: Buffer.from(ownerBytes(value.owner)),
    height: new BN(value.height.toString()),
    sequence: new BN(value.sequence.toString()),
  };
}
export function statusAddress(program: web3.PublicKey, id: SinkId) {
  const value = anchorId(id);
  return web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("transfer"),
      proofNonce(value.owner),
      value.height.toArrayLike(Buffer, "le", 8),
      value.sequence.toArrayLike(Buffer, "le", 8),
    ],
    program,
  )[0];
}
export function coinAmount(
  coin: RecordData["amount"],
  positive = false,
): bigint {
  assert.ok(
    coin && coin.denom === "uakt" && /^(0|[1-9][0-9]*)$/.test(coin.amount),
    "invalid uakt Coin",
  );
  const amount = BigInt(coin.amount);
  assert.ok(!positive || amount > 0n, "amount must be positive");
  return amount;
}
export function recordData(data: RecordData | undefined) {
  assert.ok(data, "missing record data");
  const recipient = new web3.PublicKey(data.dest),
    amount = coinAmount(data.amount, true);
  assert.equal(recipient.toBase58(), data.dest, "noncanonical recipient");
  assert.ok(amount <= MAX_UINT64, "transfer amount exceeds uint64");
  return { recipient, amount };
}
export function decodeRecord(transfer: TransferState) {
  const id = parseSinkId(transfer.id);
  return { id, height: sinkIdParts(id).height, ...recordData(transfer.data) };
}

export function matchesAnchorId(
  value: ReturnType<typeof anchorId>,
  id: SinkId,
) {
  const expected = anchorId(id);
  return (
    Buffer.from(value.owner).equals(expected.owner) &&
    value.height.eq(expected.height) &&
    value.sequence.eq(expected.sequence)
  );
}
