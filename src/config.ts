import { isAbsolute } from "node:path";
import { web3 } from "@coral-xyz/anchor";
import { z } from "zod";
export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

const address = z.string().refine((value) => {
  try {
    return new web3.PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}, "Expected a canonical Solana public address");
const rpc = z
  .string()
  .url()
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol));

export const configSchema = z
  .object({
    akashRpcs: z.array(rpc).min(1),
    solanaRpcs: z.array(rpc).min(1),
    akashChainId: z.string().min(1).default("akashnet-2"),
    solanaGenesis: z.string().default(MAINNET_GENESIS),
    programId: address,
    lightClientProgramId: address,
    mint: address,
    squadsVault: address,
    publicUrl: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          url.pathname === "/" &&
          !url.search &&
          !url.hash
        );
      }, "Use the monitor's HTTPS origin without credentials, a path, or query")
      .optional(),
    stateDir: z.string().refine(isAbsolute),
    intervalSeconds: z.number().int().min(5).default(15),
    staleSeconds: z.number().int().min(30).default(120),
    startupGraceSeconds: z.number().int().min(30).default(300),
    pendingWarningSeconds: z.number().int().positive().default(300),
    pendingCriticalSeconds: z.number().int().positive().default(900),
    reportLagSeconds: z.number().int().positive().default(600),
    refundLagSeconds: z.number().int().positive().default(600),
    capWarningPercent: z.number().int().min(1).max(100).default(80),
    capCriticalPercent: z.number().int().min(1).max(100).default(95),
    alertRepeatSeconds: z.number().int().min(60).default(600),
    summaryIntervalSeconds: z.number().int().min(60).default(7200),
    activityBurstLimit: z.number().int().min(1).max(100).default(5),
    activityDigestSeconds: z.number().int().min(60).default(600),
    slackMemberId: z
      .string()
      .regex(/^[UW][A-Z0-9]+$/)
      .optional(),
    slackChannel: z.string().default("akash-sink-monitor"),
    listenHost: z.string().default("127.0.0.1"),
    listenPort: z.number().int().min(1024).max(65535).default(9465),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.pendingCriticalSeconds < value.pendingWarningSeconds ||
      value.capCriticalPercent < value.capWarningPercent
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Critical thresholds must not precede warning thresholds",
      });
    }
  });
export type Config = z.infer<typeof configSchema>;
