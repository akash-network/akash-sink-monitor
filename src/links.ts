import { MAINNET_GENESIS, type Config } from "./config";
import { signatureSchema, txHashSchema, type Transfer } from "./model";

export function akashTxLink(
  hash: string,
  config: Config,
  label = "Akash transaction",
): string {
  txHashSchema.parse(hash);
  return config.akashChainId === "akashnet-2"
    ? `<https://www.mintscan.io/akash/tx/${hash}|${label}>`
    : `Akash transaction: ${hash}`;
}

export function solanaTxLink(signature: string, config: Config): string {
  signatureSchema.parse(signature);
  return config.solanaGenesis === MAINNET_GENESIS
    ? `<https://explorer.solana.com/tx/${signature}|Solana transaction>`
    : `Solana transaction: ${signature}`;
}

export function transferLinks(row: Transfer, config: Config): string {
  const links = [];
  if (row.depositTxHash)
    links.push(akashTxLink(row.depositTxHash, config, "Original deposit"));
  if (row.solanaTxSignature)
    links.push(solanaTxLink(row.solanaTxSignature, config));
  return links.join(" · ");
}
