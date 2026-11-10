export const slackEscape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function formatAkt(value: string): string {
  const amount = BigInt(value);
  const absolute = amount < 0n ? -amount : amount;
  const whole = (absolute / 1_000_000n).toLocaleString("en-US");
  const fraction = (absolute % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `${amount < 0n ? "-" : ""}${whole}${fraction ? "." + fraction : ""}`;
}

export function formatDuration(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  if (minutes < 1) return `${Math.floor(Math.max(0, seconds))}s`;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  return `${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ""}`;
}

export function statusLabel(value: string): string {
  const words = value
    .replace(/^(STATUS_|HOLD_)/, "")
    .toLowerCase()
    .replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
