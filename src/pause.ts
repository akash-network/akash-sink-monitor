import assert from "node:assert/strict";
import { web3 } from "@coral-xyz/anchor";
import { base58 } from "@scure/base";
import idl from "../idl/akt.json";
import { pda } from "../vendor/common";
import type { Config } from "./config";

// An unsigned instruction-import envelope. Squads creates its own transaction
// and supplies its vault PDA signature after members approve. Never broadcast
// this container directly; its placeholder blockhash is deliberately inert.
export function pauseImport(
  config: Pick<Config, "programId" | "squadsVault">,
): string {
  const authority = new web3.PublicKey(config.squadsVault);
  const programId = new web3.PublicKey(config.programId);
  const definition = idl.instructions.find(
    (entry) => entry.name === "guardian_pause",
  );
  assert(definition, "Bundled IDL has no guardian_pause");
  assert.equal(
    definition.args.length,
    0,
    "guardian_pause must have no arguments",
  );
  assert.equal(definition.discriminator.length, 8);
  const accounts = new Map([
    ["guardian", authority],
    ["pause_guardian", pda("guardian", programId)],
    ["config", pda("config", programId)],
  ]);
  const instruction = new web3.TransactionInstruction({
    programId,
    keys: definition.accounts.map((account) => {
      const pubkey = accounts.get(account.name);
      assert(pubkey, "Unexpected guardian_pause IDL account");
      return {
        pubkey,
        isSigner: "signer" in account && account.signer === true,
        isWritable: "writable" in account && account.writable === true,
      };
    }),
    data: Buffer.from(definition.discriminator),
  });
  const tx = new web3.Transaction({
    feePayer: authority,
    recentBlockhash: web3.PublicKey.default.toBase58(),
  }).add(instruction);
  const bytes = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
  const decoded = web3.Transaction.from(bytes);
  assert.equal(decoded.instructions.length, 1);
  assert(decoded.instructions[0].data.equals(instruction.data));
  assert(decoded.signatures.every((entry) => entry.signature === null));
  return base58.encode(bytes);
}

export function squadsUrl(config: Pick<Config, "squadsVault">): string {
  return `https://app.squads.so/squads/${config.squadsVault}/transactions?tab=Vault`;
}

export function pausePanelUrl(
  config: Pick<Config, "publicUrl">,
): string | undefined {
  return config.publicUrl
    ? new URL("/#pause-action", config.publicUrl).href
    : undefined;
}
