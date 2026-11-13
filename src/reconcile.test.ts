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
): Awaited<ReturnType<AkashClient["state"]>> {
  const state = QueryStateResponse.fromPartial({
    epoch: 1n,
    totals: {
      pendingAmount: coin(2_000_000n),
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

async function fixture(t: TestContext) {
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
  const arrival = transfer(101n);
  const current = {
    history: [...original, arrival],
    height: 102,
    supply: 2_000_000n,
    laterSlot: 1000,
    truncateArrivalPage: false,
  };
  const accounts = new Map<string, web3.AccountInfo<Buffer>>();
  let stateReads = 0;
  t.mock.method(AkashClient.prototype, "state", async () =>
    nativeState(stateReads++ === 0 ? 100 : current.height),
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
          balance: coin(2_000_000n),
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
          if (!isSupplyPage) assert.equal(options.minContextSlot, 1000);
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
          const page = {
            context: { slot: isSupplyPage ? 1000 : current.laterSlot },
            value: addresses.map((address) => {
              const account =
                address === mint.toBase58()
                  ? {
                      data,
                      owner: TOKEN_PROGRAM_ID,
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
          result = page;
          break;
        }
        case "getGenesisHash":
          result = genesis;
          break;
        case "getFirstAvailableBlock":
          result = 1;
          break;
        case "getSignaturesForAddress":
          result = [];
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
    directory,
    reconcile: () =>
      reconcileConfigured({
        connection,
        programId,
        akashRpc: "https://akash.example",
        chainId: "akashnet-2",
        stateDir: directory,
        reportLagSeconds: 600,
      }),
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
