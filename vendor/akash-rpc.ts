import { HttpClient } from "@cosmjs/tendermint-rpc";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";

const httpCause = z.object({ status: z.number().int() });
const transientStatuses = new Set([408, 500, 502, 503, 504]);
const reads = new Set([
  "status",
  "abci_info",
  "abci_query",
  "block",
  "block_results",
  "commit",
  "validators",
  "tx",
  "tx_search",
  "block_search",
]);

type Diagnostic = {
  event: "akash-rpc-retry" | "akash-rpc-failed";
  host: string;
  method: string;
  status: number | null;
  attempt: number;
  reason: "http" | "transport" | "rpc-response";
};

export class AkashRpcClient extends HttpClient {
  constructor(
    endpoint: ConstructorParameters<typeof HttpClient>[0],
    timeout?: number,
    private readonly log: (entry: Diagnostic) => void = (entry) => {
      process.stdout.write(
        JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n",
      );
    },
  ) {
    super(endpoint, timeout);
  }
  override async execute(request: Parameters<HttpClient["execute"]>[0]) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await super.execute(request);
      } catch (error) {
        const cause = httpCause.safeParse(
          error instanceof Error ? error.cause : undefined,
        );
        const status = cause.success ? cause.data.status : null;
        const transport =
          error instanceof Error &&
          (error.name === "TypeError" || error.name === "TimeoutError");
        const retry =
          attempt < 2 &&
          reads.has(request.method) &&
          (status !== null ? transientStatuses.has(status) : transport);
        const method = reads.has(request.method) ? request.method : "other";
        const host = new URL(this.url).hostname;
        this.log({
          event: retry ? "akash-rpc-retry" : "akash-rpc-failed",
          host,
          method,
          status,
          attempt,
          reason:
            status !== null ? "http" : transport ? "transport" : "rpc-response",
        });
        if (!retry)
          throw new Error(
            `Akash RPC ${method} failed on ${host}${status === null ? "" : ` (HTTP ${status})`}`,
          );
        await setTimeout(300);
      }
    }
  }
}
