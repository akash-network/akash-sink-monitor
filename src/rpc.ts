import { setTimeout } from "node:timers/promises";
import { z } from "zod";

const requestSchema = z.object({
  method: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/),
});
const retryable = new Set([408, 429, 500, 502, 503, 504]);

type Diagnostic = {
  event: "solana-rpc-retry" | "solana-rpc-failed";
  host: string;
  method: string;
  status: number | null;
  attempt: number;
  delayMs: number;
};

const defaults = {
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  now: () => Date.now(),
  random: () => Math.random(),
  sleep: (ms: number, signal: AbortSignal) =>
    setTimeout(ms, undefined, { signal }),
  log: (fields: Diagnostic) => {
    process.stdout.write(
      JSON.stringify({ time: new Date().toISOString(), ...fields }) + "\n",
    );
  },
};

function methodName(body: RequestInit["body"]) {
  if (typeof body !== "string") return "unknown";
  try {
    const request = requestSchema.safeParse(JSON.parse(body));
    return request.success ? request.data.method : "unknown";
  } catch {
    return "unknown";
  }
}

function retryAfterMs(value: string | null, now: number) {
  if (value === null) return 0;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

export function createSolanaRpcFetch(
  overrides: Partial<typeof defaults> = {},
): typeof fetch {
  const io = { ...defaults, ...overrides };
  const endpoints = new Map<
    string,
    { nextStart: number; cooldownUntil: number; turn: Promise<void> }
  >();

  return async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const spacingMs =
      url.hostname === "mainnet.helius-rpc.com" ||
      url.hostname === "beta.helius-rpc.com"
        ? 167
        : 250;
    const key = url.toString();
    const gate = endpoints.get(key) ?? {
      nextStart: 0,
      cooldownUntil: 0,
      turn: Promise.resolve(),
    };
    endpoints.set(key, gate);
    const callerSignal =
      init.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = AbortSignal.any([
      AbortSignal.timeout(20_000),
      ...(callerSignal ? [callerSignal] : []),
    ]);

    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted();
      const turn = gate.turn.then(async () => {
        signal.throwIfAborted();
        let delay = Math.max(gate.nextStart, gate.cooldownUntil) - io.now();
        while (delay > 0) {
          await io.sleep(delay, signal);
          signal.throwIfAborted();
          delay = Math.max(gate.nextStart, gate.cooldownUntil) - io.now();
        }
        gate.nextStart = io.now() + spacingMs;
      });
      gate.turn = turn.catch(() => {});
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        turn.then(
          () => {
            signal.removeEventListener("abort", abort);
            resolve();
          },
          (error: unknown) => {
            signal.removeEventListener("abort", abort);
            reject(error);
          },
        );
      });

      let response: Response | undefined;
      try {
        response = await io.fetch(
          input instanceof Request ? input.clone() : input,
          { ...init, signal },
        );
        if (!retryable.has(response.status)) {
          if (!response.ok) return response;
          const body =
            response.body === null ? null : await response.arrayBuffer();
          return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
      } catch (error) {
        if (signal.aborted || !(error instanceof TypeError)) {
          io.log({
            event: "solana-rpc-failed",
            host: url.hostname,
            method: methodName(init.body),
            status: null,
            attempt,
            delayMs: 0,
          });
          throw new Error(
            `Solana RPC ${methodName(init.body)} failed on ${url.hostname}`,
          );
        }
        response = undefined;
      }
      const delayMs = Math.ceil(
        Math.max(
          1000 * 2 ** (attempt - 1) * (0.75 + io.random() * 0.5),
          retryAfterMs(response?.headers.get("retry-after") ?? null, io.now()),
        ),
      );
      gate.cooldownUntil = Math.max(gate.cooldownUntil, io.now() + delayMs);
      io.log({
        event: attempt < 4 ? "solana-rpc-retry" : "solana-rpc-failed",
        host: url.host,
        method: methodName(init.body),
        status: response?.status ?? null,
        attempt,
        delayMs,
      });
      if (attempt === 4) {
        if (response) return response;
        throw new Error(
          `Solana RPC ${methodName(init.body)} failed on ${url.hostname}`,
        );
      }
      await response?.body?.cancel();
    }
  };
}

// Snapshot and optional receipt lookups share the same endpoint budget.
export const solanaRpcFetch = createSolanaRpcFetch();
