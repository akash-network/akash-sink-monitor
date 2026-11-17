import assert from "node:assert/strict";
import { join } from "node:path";
import { z } from "zod";
import type { AkashClient } from "../vendor/akash";
import { atomicJson, optionalJson } from "../vendor/durable";

const cacheSchema = z.object({
  version: z.literal(1),
  chainId: z.string(),
  times: z.record(
    z.string().regex(/^[1-9][0-9]*$/),
    z.number().int().nonnegative(),
  ),
});

export async function collectDepositTimes(input: {
  akash: AkashClient;
  chainId: string;
  stateDir: string;
  state: Pick<Awaited<ReturnType<AkashClient["state"]>>, "height" | "time">;
  heights: bigint[];
}): Promise<Map<string, number>> {
  const { akash, chainId, stateDir, state, heights } = input;
  const result = new Map<string, number>();
  if (heights.length === 0) return result;
  const path = join(stateDir, "deposit-times.json");
  const saved = await optionalJson(path);
  const cache = cacheSchema.parse(saved ?? { version: 1, chainId, times: {} });
  assert.equal(cache.chainId, chainId, "wrong deposit timestamp cache chain");
  let changed = false;
  try {
    for (const height of new Set(heights)) {
      assert(
        height > 0n && height <= BigInt(state.height),
        "deposit height outside native snapshot",
      );
      const key = height.toString();
      let time = cache.times[key];
      if (time === undefined) {
        const { header } = (await akash.comet.block(Number(height))).block;
        assert.equal(header.chainId, chainId, "wrong deposit block chain");
        assert.equal(
          header.height,
          Number(height),
          "wrong deposit block height",
        );
        time = Math.floor(header.time.getTime() / 1000);
        assert(
          Number.isSafeInteger(time) && time >= 0 && time <= Number(state.time),
          "invalid deposit block time",
        );
        cache.times[key] = time;
        changed = true;
      }
      assert(time <= Number(state.time), "deposit time after native snapshot");
      result.set(key, time);
    }
    return result;
  } finally {
    // Committed block times remain useful when a later read or snapshot fails.
    if (changed) await atomicJson(path, cache);
  }
}
