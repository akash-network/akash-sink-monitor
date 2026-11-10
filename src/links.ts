import { MAINNET_GENESIS, type Config } from "./config";
import {
  signatureSchema,
  txHashSchema,
  type Snapshot,
  type Transfer,
} from "./model";

export function akashTxLink(hash: string, config: Config): string {
  txHashSchema.parse(hash);
  return config.akashChainId === "akashnet-2"
    ? `<https://www.mintscan.io/akash/tx/${hash}|Akash transaction ${hash}>`
    : `Akash transaction: ${hash}`;
}

export function solanaTxLink(signature: string, config: Config): string {
  signatureSchema.parse(signature);
  return config.solanaGenesis === MAINNET_GENESIS
    ? `<https://explorer.solana.com/tx/${signature}|Solana transaction ${signature}>`
    : `Solana transaction: ${signature}`;
}

export function observationLinks(snapshot: Snapshot, config: Config): string {
  const akash =
    config.akashChainId === "akashnet-2"
      ? `<https://www.mintscan.io/akash/block/${snapshot.akashHeight}|Akash block ${snapshot.akashHeight}>`
      : `Akash block ${snapshot.akashHeight}`;
  const solana =
    config.solanaGenesis === MAINNET_GENESIS
      ? `<https://explorer.solana.com/block/${snapshot.solanaSlot}|Solana slot ${snapshot.solanaSlot}>`
      : `Solana slot ${snapshot.solanaSlot}`;
  return `Observed at ${akash} · ${solana} (${snapshot.checkedAt}). These are observation blocks, not transaction receipts.`;
}

export function transferLinks(row: Transfer, config: Config): string {
  const deposit = row.depositTxHash
    ? akashTxLink(row.depositTxHash, config)
    : "Akash deposit transaction lookup unavailable; retrying.";
  const resolution = row.solanaTxSignature
    ? solanaTxLink(row.solanaTxSignature, config)
    : row.solana === "pending"
      ? "No finalized Solana result yet."
      : "Solana resolution transaction lookup unavailable; retrying.";
  const refund =
    row.akash === "STATUS_REFUNDED"
      ? "\nRefund observed in chain state; the links above identify the original deposit and Solana resolution, not a refund transaction. Refunds may execute automatically in a block."
      : "";
  return `${deposit}\n${resolution}${refund}`;
}
