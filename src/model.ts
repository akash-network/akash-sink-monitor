import { z } from "zod";
import { base58 } from "@scure/base";
import { slackThreadSchema } from "./slack";

export const uint = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const txHashSchema = z.string().regex(/^[A-F0-9]{64}$/);
export const signatureSchema = z.string().refine((value) => {
  try {
    return base58.decode(value).length === 64;
  } catch {
    return false;
  }
}, "Expected a Solana transaction signature");
export const burnSchema = z.object({
  signature: signatureSchema,
  slot: z.number().int().positive(),
  amount: uint,
});
export const alertSchema = z.object({
  key: z.string(),
  severity: z.enum(["warning", "critical"]),
  title: z.string(),
  detail: z.string(),
  transferId: z.string().optional(),
});
export type Alert = z.infer<typeof alertSchema>;

export const transferSchema = z.object({
  id: z.string(),
  owner: z.string(),
  recipient: z.string(),
  amountUakt: uint,
  depositedAt: z.number().int(),
  akash: z.string(),
  hold: z.string(),
  solana: z.enum(["pending", "minted", "voided"]),
  resolvedAtSlot: uint.nullable(),
  resolvedObservedAt: z.number().int().nullable(),
  challengeEnd: uint,
  votes: z.number().int().nonnegative(),
  quorum: z.number().int().nonnegative(),
  vetoReason: z.string(),
  depositTxHash: txHashSchema.nullable().default(null),
  solanaTxSignature: signatureSchema.nullable().default(null),
  receiptCheckedAt: z.number().int().nonnegative().default(0),
});
export const capSchema = z.object({
  key: z.string(),
  label: z.string(),
  usedUakt: uint,
  limitUakt: uint,
  period: z.string(),
});
export const snapshotSchema = z.object({
  checkedAt: z.string().datetime(),
  akashHeight: z.number().int().positive(),
  solanaSlot: z.number().int().positive(),
  akashTime: z.number().int(),
  solanaTime: z.number().int(),
  lockedUakt: uint,
  accountedEscrowUakt: uint,
  mintedUakt: uint,
  supplyUakt: uint,
  burnedUakt: uint,
  depositedUakt: uint,
  refundedUakt: uint,
  awaitingReportsUakt: uint,
  pendingUakt: uint,
  refundPendingUakt: uint,
  depositsEnabled: z.boolean(),
  refundsEnabled: z.boolean(),
  mintingEnabled: z.boolean(),
  client: z.object({
    status: z.enum(["active", "expired", "frozen"]),
    height: uint,
    ageSeconds: z.number(),
    trustingPeriodSeconds: z.number().positive(),
    program: z.string(),
  }),
  reporters: z
    .object({
      version: uint,
      members: z.array(z.string()),
      quorum: z.number().int().nonnegative(),
    })
    .nullable()
    .default(null),
  guardian: z.string().nullable(),
  nativeGuardian: z.string(),
  caps: z.array(capSchema),
  transfers: z.array(transferSchema),
  burns: z.array(burnSchema).default([]),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Transfer = z.infer<typeof transferSchema>;
export type Cap = z.infer<typeof capSchema>;

export const reporterActivitySchema = z.object({
  since: z.number().int(),
  through: z.number().int(),
  height: z.number().int().nonnegative(),
  lastReportAt: z.record(z.string(), z.number().int()),
});
export type ReporterActivity = z.infer<typeof reporterActivitySchema>;

export const monitorStateSchema = z.object({
  version: z.literal(1),
  identity: z.string(),
  startedAt: z.number(),
  rejectionHeight: z.number().int().nonnegative(),
  reporterActivity: reporterActivitySchema.nullable().default(null),
  snapshot: snapshotSchema.nullable(),
  active: z.record(z.string(), alertSchema),
  slackThreads: z.record(z.string(), slackThreadSchema).default({}),
  slackNextPostAt: z.number().nonnegative().default(0),
  delivered: z.record(
    z.string(),
    z.object({
      fingerprint: z.string(),
      sentAt: z.number(),
    }),
  ),
  outbox: z.array(
    z.object({
      id: z.string(),
      key: z.string(),
      text: z.string(),
      createdAt: z.number(),
      fingerprint: z.string(),
      transferId: z.string().optional(),
    }),
  ),
  events: z.array(
    z.object({
      id: z.string(),
      at: z.string(),
      detail: z.string(),
    }),
  ),
  pauseImport: z.string().nullable(),
});
export type MonitorState = z.infer<typeof monitorStateSchema>;

export function akt(value: string): string {
  const n = BigInt(value);
  return `${n / 1_000_000n}.${(n % 1_000_000n).toString().padStart(6, "0")}`;
}
