import assert from "node:assert/strict";
import { Program, utils, web3 } from "@coral-xyz/anchor";
import type { Akt } from "../idl/akt";

export async function statusAccounts(input: {
  connection: web3.Connection;
  program: Program<Akt>;
  addresses: web3.PublicKey[];
  slot: number;
}) {
  const { connection, program, addresses, slot } = input;
  if (!addresses.length) return [];
  const started = Date.now();
  const discriminator = program.idl.accounts?.find(
    (account) => account.name === "transferStatus",
  )?.discriminator;
  assert(discriminator, "missing transfer status discriminator");
  const found = new Map<string, web3.AccountInfo<Buffer> | null>();
  const bulk = await connection
    .getProgramAccounts(program.programId, {
      commitment: "finalized",
      minContextSlot: slot,
      withContext: true,
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: utils.bytes.bs58.encode(Buffer.from(discriminator)),
          },
        },
      ],
    })
    .catch(() => null);
  if (bulk) {
    assert(bulk.context.slot >= slot, "Solana status context regressed");
    for (const { pubkey, account } of bulk.value) {
      const key = pubkey.toBase58();
      assert(!found.has(key), "duplicate Solana status account");
      assert(
        account.owner.equals(program.programId) && !account.executable,
        "invalid Solana status owner",
      );
      found.set(key, account);
    }
  }
  // Bulk responses may be truncated. Only explicit address reads prove absence.
  const missing = addresses.filter((address) => !found.has(address.toBase58()));
  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100);
    const page = await connection.getMultipleAccountsInfoAndContext(batch, {
      commitment: "finalized",
      minContextSlot: slot,
    });
    assert(page.context.slot >= slot, "Solana status context regressed");
    assert.equal(
      page.value.length,
      batch.length,
      "incomplete Solana account page",
    );
    batch.forEach((address, index) =>
      found.set(address.toBase58(), page.value[index]),
    );
  }
  process.stdout.write(
    JSON.stringify({
      time: new Date().toISOString(),
      event: "solana-status-read",
      elapsedMs: Date.now() - started,
      requested: addresses.length,
      bulkAvailable: bulk !== null,
      explicitReads: missing.length,
    }) + "\n",
  );
  return addresses.map((address) => {
    const info = found.get(address.toBase58());
    assert(info !== undefined, "missing Solana status result");
    return info;
  });
}
