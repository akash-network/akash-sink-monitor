import assert from "node:assert/strict";
import {
  Sink_Status as Status,
  type TransferState,
} from "@akashnetwork/chain-sdk/private-types/akash.v1";
import type { AkashClient } from "./akash";
import { parseSinkId, type SinkId, compareIds } from "./id";
export type TransferEntry = { id: SinkId; transfer: TransferState };
export type Page = { transfers: TransferState[]; nextKey: Uint8Array };
export type DiscoveryCursor =
  | { kind: "next"; key: Uint8Array; lastId: SinkId }
  | { kind: "tail"; key: Uint8Array; lastId: SinkId };
export async function collectPages(
  read: (key: Uint8Array) => Promise<Page>,
): Promise<TransferEntry[]> {
  const result: TransferEntry[] = [],
    seen = new Set<string>(),
    cursors = new Set<string>([""]);
  let key: Uint8Array = new Uint8Array();
  for (;;) {
    const page = await read(key);
    for (const transfer of page.transfers) {
      const id = parseSinkId(transfer.id);
      assert.ok(!seen.has(id), "duplicate transfer in paginated query");
      seen.add(id);
      result.push({ id, transfer });
    }
    if (page.nextKey.length === 0) return result;
    const next = Buffer.from(page.nextKey).toString("base64");
    assert.ok(
      page.transfers.length > 0 && !cursors.has(next),
      "pagination cursor did not advance",
    );
    cursors.add(next);
    key = page.nextKey;
  }
}
