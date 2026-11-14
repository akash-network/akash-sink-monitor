import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BN, Program, web3, type IdlAccounts } from "@coral-xyz/anchor";
import { MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Comet38Client } from "@cosmjs/tendermint-rpc";
import { QueryBalanceResponse } from "cosmjs-types/cosmos/bank/v1beta1/query";
import {
  TransferState,
  QueryStateResponse,
  Sink_QueryParamsResponse,
  QueryReportersResponse,
  Sink_Status as Status,
} from "@akashnetwork/chain-sdk/private-types/akash.v1";
import { z } from "zod";
import idl from "../idl/akt.json";
import type { Akt } from "../idl/akt";
import { AkashClient } from "../vendor/akash";
import { pda } from "../vendor/common";
import { anchorId, decodeRecord, statusAddress } from "../vendor/proof";
import { reconcileConfigured } from "../vendor/reconcile";

const programId = new web3.PublicKey(idl.address);
const mint = pda("mint", programId);
const owner = "akash15cx0kl8q6k4dcxnwkwy8magmj2y2v8dg7utdun";
const recipient = new web3.PublicKey(
  "H2sXJRVW3SnTdFGjTXpGSsVKN2HnDaKc6xLRomS36H3U",
);
const genesis = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const coin = (amount: bigint) => ({ denom: "uakt", amount: amount.toString() });

function transfer(height: bigint) {
  return TransferState.fromPartial({
    id: { owner, height, sequence: 1n },
    status: Status.STATUS_TRANSFER_PENDING,
    data: { amount: coin(1_000_000n), dest: recipient.toBase58() },
    settlement: { policy: { version: 1n, members: [owner], threshold: "1" } },
  });
}

function nativeState(
  height: number,
  escrow = 2_000_000n,
): Awaited<ReturnType<AkashClient["state"]>> {
  const state = QueryStateResponse.fromPartial({
    epoch: 1n,
    totals: {
      pendingAmount: coin(escrow),
      pendingCount: 2n,
      mintedAmount: coin(0n),
      voidedAmount: coin(0n),
      refundPendingAmount: coin(0n),
    },
    sendUsage: { epoch: 1n, amount: coin(2_000_000n) },
    refundUsage: { epoch: 1n, amount: coin(0n) },
  });
  const { params } = Sink_QueryParamsResponse.fromPartial({ params: {} });
  const { reporters } = QueryReportersResponse.fromPartial({
    reporters: [{ version: 1n, members: [owner], threshold: "1" }],
  });
  assert(state.totals && state.sendUsage && state.refundUsage && params);
  return {
    ...state,
    totals: state.totals,
    sendUsage: state.sendUsage,
    refundUsage: state.refundUsage,
    params,
    policy: reporters[0],
    height,
    time: BigInt(Math.floor(Date.now() / 1000)),
  };
}

async function fixture(t: TestContext, recordCount = 2) {
  await mkdir(".cache", { recursive: true });
  const directory = await mkdtemp(".cache/reconcile-arrivals-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, "burn-index.json"),
    JSON.stringify({
      genesis,
      mint: mint.toBase58(),
      slot: 999,
      burned: "0",
      cursor: "previous-finalized-transaction",
      genesisTransaction: "mint-initialization",
    }),
  );
  const original = [transfer(90n), transfer(91n)];
  for (let i = 2; i < recordCount; i++) {
    const row = transfer(92n);
    assert(row.id);
    row.id.sequence = BigInt(i);
    original.push(row);
  }
  const escrow = BigInt(recordCount) * 1_000_000n;
  const arrival = transfer(101n);
  const current = {
    history: [...original, arrival],
    height: 102,
    supply: escrow,
    supplySlot: 1000,
    clockSlot: 1000,
    laterSlot: 1000,
    truncateArrivalPage: false,
    truncateOriginalPage: false,
    burnRootSlot: 1002,
    burnSlot: 0,
  };
  const accounts = new Map<string, web3.AccountInfo<Buffer>>();
  let stateReads = 0;
  t.mock.method(AkashClient.prototype, "state", async () =>
    nativeState(stateReads++ === 0 ? 100 : current.height, escrow),
  );
  t.mock.method(AkashClient.prototype, "transfers", async (height: number) => ({
    transfers: height === 100 ? original : current.history,
    nextKey: new Uint8Array(),
  }));
  t.mock.method(
    Comet38Client.prototype,
    "abciQuery",
    async (
      request: Parameters<Comet38Client["abciQuery"]>[0],
    ): Promise<Awaited<ReturnType<Comet38Client["abciQuery"]>>> => {
      assert.equal(request.path, "/cosmos.bank.v1beta1.Query/Balance");
      assert.equal(request.height, 100);
      return {
        code: 0,
        codespace: "",
        info: "",
        key: new Uint8Array(),
        height: 100,
        value: QueryBalanceResponse.encode({
          balance: coin(escrow),
        }).finish(),
      };
    },
  );
  const requestSchema = z.object({
    id: z.union([z.string(), z.number()]),
    method: z.string(),
    params: z.array(z.unknown()),
  });
  const connection = new web3.Connection("https://solana.example", {
    commitment: "finalized",
    fetch: async (_url, init) => {
      assert(init && typeof init.body === "string");
      const request = requestSchema.parse(JSON.parse(String(init.body)));
      let result: unknown;
      switch (request.method) {
        case "getMultipleAccounts": {
          const addresses = z.array(z.string()).parse(request.params[0]);
          const options = z
            .object({
              commitment: z.literal("finalized"),
              minContextSlot: z.number(),
            })
            .parse(request.params[1]);
          const isSupplyPage = addresses.includes(mint.toBase58());
          if (!isSupplyPage)
            assert.equal(options.minContextSlot, current.supplySlot);
          const data = Buffer.alloc(MintLayout.span);
          MintLayout.encode(
            {
              mintAuthorityOption: 1,
              mintAuthority: pda("mint_authority", programId),
              supply: current.supply,
              decimals: 6,
              isInitialized: true,
              freezeAuthorityOption: 0,
              freezeAuthority: web3.PublicKey.default,
            },
            data,
          );
          const clock = Buffer.alloc(40);
          clock.writeBigUInt64LE(BigInt(current.clockSlot));
          const page = {
            context: {
              slot: isSupplyPage ? current.supplySlot : current.laterSlot,
            },
            value: addresses.map((address) => {
              const account =
                address === mint.toBase58()
                  ? {
                      data,
                      owner: TOKEN_PROGRAM_ID,
                      lamports: 1,
                      executable: false,
                    }
                  : address === web3.SYSVAR_CLOCK_PUBKEY.toBase58()
                    ? {
                        data: clock,
                        owner: new web3.PublicKey(
                          "Sysvar1111111111111111111111111111111111111",
                        ),
                        lamports: 1,
                        executable: false,
                      }
                    : accounts.get(address);
              return account
                ? {
                    ...account,
                    rentEpoch: 0,
                    owner: account.owner.toBase58(),
                    data: [account.data.toString("base64"), "base64"],
                  }
                : null;
            }),
          };
          if (!isSupplyPage && current.truncateArrivalPage) page.value.pop();
          const lastOriginal = original.at(-1);
          assert(lastOriginal);
          if (
            current.truncateOriginalPage &&
            addresses.includes(
              statusAddress(
                programId,
                decodeRecord(lastOriginal).id,
              ).toBase58(),
            )
          )
            page.value.pop();
          result = page;
          break;
        }
        case "getGenesisHash":
          result = genesis;
          break;
        case "getFirstAvailableBlock":
          result = 1;
          break;
        case "getSignaturesForAddress": {
          const options = z
            .object({
              minContextSlot: z.number().optional(),
              before: z.string().optional(),
            })
            .parse(request.params[1]);
          if ((options.minContextSlot ?? 0) > current.burnRootSlot)
            throw new Error("Minimum context slot has not been reached");
          result =
            current.burnSlot &&
            current.burnSlot <= current.burnRootSlot &&
            !options.before
              ? [
                  {
                    signature: "burn-transaction",
                    slot: current.burnSlot,
                    err: null,
                    memo: null,
                    blockTime: 1,
                  },
                ]
              : [];
          break;
        }
        case "getTransaction":
          result = {
            slot: current.burnSlot,
            blockTime: 1,
            version: "legacy",
            transaction: {
              signatures: ["burn-transaction"],
              message: {
                accountKeys: [],
                recentBlockhash: web3.PublicKey.default.toBase58(),
                instructions: [
                  {
                    program: "spl-token",
                    programId: TOKEN_PROGRAM_ID.toBase58(),
                    parsed: {
                      type: "burn",
                      info: { mint: mint.toBase58(), amount: "1000000" },
                    },
                  },
                ],
              },
            },
            meta: {
              err: null,
              fee: 0,
              preBalances: [],
              postBalances: [],
              innerInstructions: [],
            },
          };
          break;
        default:
          assert.fail("Unexpected RPC: " + request.method);
      }
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      );
    },
  });
  const program = new Program<Akt>(idl, { connection });
  async function resolve(
    entry: TransferState,
    slot: number,
    mutate?: (status: IdlAccounts<Akt>["transferStatus"]) => void,
  ) {
    const record = decodeRecord(entry);
    const status: IdlAccounts<Akt>["transferStatus"] = {
      id: anchorId(record.id),
      proofHeight: new BN((record.height + 1n).toString()),
      resolvedAtSlot: new BN(slot),
      outcome: {
        minted: { amount: new BN(record.amount.toString()), recipient },
      },
    };
    mutate?.(status);
    const account = {
      data: await program.coder.accounts.encode("transferStatus", status),
      owner: programId,
      lamports: 1,
      executable: false,
    };
    accounts.set(statusAddress(programId, record.id).toBase58(), account);
    return account;
  }
  for (const entry of original) await resolve(entry, 990);
  return {
    arrival,
    current,
    original,
    resolve,
    clearStatus: (entry: TransferState) =>
      accounts.delete(
        statusAddress(programId, decodeRecord(entry).id).toBase58(),
      ),
    directory,
    reconcile: () => {
      stateReads = 0;
      return reconcileConfigured({
        connection,
        programId,
        akashRpc: "https://akash.example",
        chainId: "akashnet-2",
        stateDir: directory,
        reportLagSeconds: 600,
      });
    },
  };
}

test("a deposit arriving during collection does not discard a complete backed snapshot", async (t) => {
  const f = await fixture(t);
  const result = await f.reconcile();
  assert.equal(result.report.status, "healthy");
  assert.equal(result.report.akashHeight, 100);
  assert.equal(result.report.solanaSlot, 1000);
  assert.equal(result.report.observedMintedUakt, "2000000");
  assert.deepEqual(
    result.records.map(({ record }) => record.id),
    f.original.map((row) => decodeRecord(row).id),
  );
  assert.equal(
    JSON.parse(await readFile(join(f.directory, "reconciliation.json"), "utf8"))
      .status,
    "healthy",
  );
});

test("a new deposit minted after the pinned slot belongs to a later poll", async (t) => {
  const f = await fixture(t);
  await f.resolve(f.arrival, 1001);
  f.current.laterSlot = 1002;
  assert.equal((await f.reconcile()).report.status, "healthy");
});

test("unchanged history still publishes the original snapshot", async (t) => {
  const f = await fixture(t);
  f.current.history = [...f.original];
  assert.equal((await f.reconcile()).report.status, "healthy");
});

for (const slot of [999, 1000]) {
  test(`a previously unseen mint at slot ${slot} still forces a fresh snapshot`, async (t) => {
    const f = await fixture(t);
    await f.resolve(f.arrival, slot);
    f.current.supply += 1_000_000n;
    await assert.rejects(
      f.reconcile(),
      /new deposit already minted at snapshot slot/,
    );
    await assert.rejects(readFile(join(f.directory, "reconciliation.json")), {
      code: "ENOENT",
    });
  });
}

test("a real supply mismatch still reaches the backing alarm with concurrent deposits", async (t) => {
  const f = await fixture(t);
  f.current.supply++;
  const { report } = await f.reconcile();
  assert.equal(report.status, "mismatch");
  assert(report.alerts.includes("backing minus supply and burns: -1 uakt"));
});

test("missing and reordered original history are rejected", async (t) => {
  for (const kind of ["missing", "reordered"]) {
    await t.test(kind, async (t) => {
      const f = await fixture(t);
      if (kind === "missing") f.current.history.shift();
      else f.current.history.reverse();
      await assert.rejects(
        f.reconcile(),
        /transfer history disappeared or reordered/,
      );
    });
  }
});

test("an earlier transfer missing from the initial history is not treated as a new arrival", async (t) => {
  const f = await fixture(t);
  f.current.history.push(transfer(95n));
  await assert.rejects(f.reconcile(), /earlier deposit missing from snapshot/);
});

test("new deposit status accounts retain owner validation", async (t) => {
  const f = await fixture(t);
  const account = await f.resolve(f.arrival, 1001);
  account.owner = TOKEN_PROGRAM_ID;
  await assert.rejects(f.reconcile(), /AssertionError/);
});

test("new deposit status accounts retain identity, proof and mint validation", async (t) => {
  const cases: {
    name: string;
    mutate: (status: IdlAccounts<Akt>["transferStatus"]) => void;
  }[] = [
    {
      name: "wrong identity",
      mutate: (status) => {
        status.id.height = new BN(99);
      },
    },
    {
      name: "proof predates deposit",
      mutate: (status) => {
        status.proofHeight = new BN(101);
      },
    },
    {
      name: "wrong amount",
      mutate: (status) => {
        assert(status.outcome.minted);
        status.outcome.minted.amount = new BN(1);
      },
    },
    {
      name: "wrong recipient",
      mutate: (status) => {
        assert(status.outcome.minted);
        status.outcome.minted.recipient = web3.PublicKey.default;
      },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async (t) => {
      const f = await fixture(t);
      await f.resolve(f.arrival, 1000, item.mutate);
      await assert.rejects(f.reconcile(), (error: unknown) => {
        assert(error instanceof assert.AssertionError);
        assert(!error.message.includes("new deposit already minted"));
        return true;
      });
    });
  }
});

test("new-deposit account reads cannot regress below the pinned slot", async (t) => {
  const f = await fixture(t);
  f.current.laterSlot = 999;
  await assert.rejects(f.reconcile(), /AssertionError/);
});

test("an incomplete new-deposit account page cannot pass as absent statuses", async (t) => {
  const f = await fixture(t);
  f.current.truncateArrivalPage = true;
  await assert.rejects(f.reconcile(), /incomplete new-deposit status page/);
});

test("native state cannot regress during the history check", async (t) => {
  const f = await fixture(t);
  f.current.height = 99;
  await assert.rejects(f.reconcile(), /Akash snapshot regressed/);
});

test("more than one page of new deposits can arrive without starving collection", async (t) => {
  const f = await fixture(t);
  f.current.height = 250;
  f.current.history.push(
    ...Array.from({ length: 101 }, (_, i) => transfer(BigInt(102 + i))),
  );
  assert.equal((await f.reconcile()).report.status, "healthy");
});

test("a newly discovered void does not add supply to the pinned snapshot", async (t) => {
  const f = await fixture(t);
  await f.resolve(f.arrival, 1000, (status) => {
    status.outcome = { voided: { reason: { invalidRecipient: {} } } };
  });
  const { report } = await f.reconcile();
  assert.equal(report.status, "healthy");
  assert.equal(report.observedMintedUakt, "2000000");
  assert.equal(report.solanaSlot, 1000);
});

test("a pre-snapshot mint on the second arrival page is not missed", async (t) => {
  const f = await fixture(t);
  f.current.height = 250;
  const last = transfer(202n);
  f.current.history.push(
    ...Array.from({ length: 100 }, (_, i) => transfer(BigInt(102 + i))),
    last,
  );
  await f.resolve(last, 1000);
  f.current.supply += 1_000_000n;
  await assert.rejects(
    f.reconcile(),
    /new deposit already minted at snapshot slot/,
  );
});

test("a malformed new-deposit status cannot count as an absent account", async (t) => {
  const f = await fixture(t);
  const account = await f.resolve(f.arrival, 1001);
  account.data = Buffer.alloc(account.data.length);
  await assert.rejects(f.reconcile(), /Invalid account discriminator/);
});

for (const recordCount of [2, 100]) {
  test(`a short original account page with ${recordCount} deposits cannot create a backing alarm`, async (t) => {
    const f = await fixture(t, recordCount);
    f.current.truncateOriginalPage = true;
    await assert.rejects(
      f.reconcile().then((result) => {
        t.diagnostic(JSON.stringify(result.report));
        return result;
      }),
      /incomplete Solana account page/,
    );
    await assert.rejects(readFile(join(f.directory, "reconciliation.json")), {
      code: "ENOENT",
    });
    const checkpoint = JSON.parse(
      await readFile(join(f.directory, "burn-index.json"), "utf8"),
    );
    assert.equal(checkpoint.slot, 999);
    f.current.truncateOriginalPage = false;
    assert.equal((await f.reconcile()).report.status, "healthy");
  });
}

test("a supply read one slot ahead of its context cannot create a false 1 AKT deficit", async (t) => {
  const f = await fixture(t);
  await f.resolve(f.original[1], 1001);
  f.current.clockSlot = 1001;
  f.current.laterSlot = 1002;
  await assert.rejects(
    f.reconcile().then((result) => {
      t.diagnostic(JSON.stringify(result.report));
      return result;
    }),
    /supply snapshot context disagrees with Clock/,
  );
  await assert.rejects(readFile(join(f.directory, "reconciliation.json")), {
    code: "ENOENT",
  });
  const checkpoint = JSON.parse(
    await readFile(join(f.directory, "burn-index.json"), "utf8"),
  );
  assert.equal(checkpoint.slot, 999);
  f.current.supplySlot = 1001;
  const { report } = await f.reconcile();
  assert.equal(report.status, "healthy");
  assert.equal(report.observedMintedUakt, "2000000");
  assert.equal(report.solanaSupplyUakt, "2000000");
  assert.equal(report.solanaSlot, 1001);
});

test("a Clock behind the supplied context is also an incomplete observation", async (t) => {
  const f = await fixture(t);
  f.current.clockSlot = 999;
  await assert.rejects(
    f.reconcile(),
    /supply snapshot context disagrees with Clock/,
  );
});

test("a mint after a coherent supply slot is excluded without an alarm", async (t) => {
  const f = await fixture(t, 100);
  const last = f.original.at(-1);
  assert(last);
  await f.resolve(last, 1001);
  f.current.laterSlot = 1002;
  f.current.supply -= 1_000_000n;
  const { report } = await f.reconcile();
  assert.equal(report.status, "healthy");
  assert.equal(report.observedMintedUakt, "99000000");
  assert.equal(report.solanaSlot, 1000);
});

for (const gap of [-1_000_000n, -1n, 1n, 1_000_000n]) {
  test(`a coherent ${gap} uakt discrepancy still reaches the backing alarm immediately`, async (t) => {
    const f = await fixture(t);
    f.current.supply -= gap;
    const { report } = await f.reconcile();
    assert.equal(report.status, "mismatch");
    assert(
      report.alerts.includes(`backing minus supply and burns: ${gap} uakt`),
    );
  });
}

test("an explicit absent status on a complete page does not hide a genuine gap", async (t) => {
  const f = await fixture(t);
  f.clearStatus(f.original[1]);
  const { report } = await f.reconcile();
  assert(
    report.alerts.includes("backing minus supply and burns: -1000000 uakt"),
  );
});

test("a burn scan behind the supply slot cannot publish a false surplus or advance its checkpoint", async (t) => {
  const f = await fixture(t);
  f.current.burnSlot = 1000;
  f.current.burnRootSlot = 999;
  f.current.supply = 1_000_000n;
  await assert.rejects(
    f.reconcile(),
    /Minimum context slot has not been reached/,
  );
  const checkpoint = JSON.parse(
    await readFile(join(f.directory, "burn-index.json"), "utf8"),
  );
  assert.equal(checkpoint.slot, 999);
  f.current.burnRootSlot = 1000;
  const { report } = await f.reconcile();
  assert.equal(report.status, "healthy");
  assert.equal(report.cumulativeBurnedUakt, "1000000");
});

test("a concurrent burn belongs to its supply slot and is not counted again after checkpointing", async (t) => {
  const f = await fixture(t);
  f.current.burnSlot = 1001;
  let result = await f.reconcile();
  assert.equal(result.report.status, "healthy");
  assert.equal(result.report.cumulativeBurnedUakt, "0");
  f.current.supplySlot = f.current.clockSlot = f.current.laterSlot = 1001;
  f.current.supply = 1_000_000n;
  result = await f.reconcile();
  assert.equal(result.report.status, "healthy");
  assert.equal(result.report.cumulativeBurnedUakt, "1000000");
  result = await f.reconcile();
  assert.equal(result.report.status, "healthy");
  assert.equal(result.report.cumulativeBurnedUakt, "1000000");
});
