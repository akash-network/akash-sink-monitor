import assert from "node:assert/strict";
import { web3 } from "@coral-xyz/anchor";
export function pda(seed: string, program: web3.PublicKey, suffix?: Buffer) {
  return web3.PublicKey.findProgramAddressSync(
    suffix ? [Buffer.from(seed), suffix] : [Buffer.from(seed)],
    program,
  )[0];
}
export function LE64(value: bigint) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}
export function object(value: unknown): Record<string, unknown> {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "JSON object required",
  );
  return Object.fromEntries(Object.entries(value));
}
