import { z } from "zod";

const channelId = z.string().regex(/^[CG][A-Z0-9]+$/);
export const slackThreadSchema = z.object({
  channelId,
  ts: z.string().regex(/^\d+\.\d+$/),
});

export type SlackTarget =
  | { kind: "webhook"; url: string }
  | { kind: "bot"; token: string; channelId: string };

export class SlackDeliveryError extends Error {}

export function slackWebhook(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.SINK_MONITOR_SLACK_WEBHOOK;
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid SINK_MONITOR_SLACK_WEBHOOK");
  }
  if (
    url.protocol !== "https:" ||
    !["hooks.slack.com", "hooks.slack-gov.com"].includes(url.hostname) ||
    !url.pathname.startsWith("/services/") ||
    url.username ||
    url.password
  ) {
    throw new Error("Invalid SINK_MONITOR_SLACK_WEBHOOK");
  }
  return value;
}

export function slackTarget(env: NodeJS.ProcessEnv): SlackTarget | undefined {
  const token = env.SINK_MONITOR_SLACK_BOT_TOKEN;
  const channel = env.SINK_MONITOR_SLACK_CHANNEL_ID;
  if (token || channel) {
    if (!token || !channel)
      throw new Error(
        "Set both SINK_MONITOR_SLACK_BOT_TOKEN and SINK_MONITOR_SLACK_CHANNEL_ID",
      );
    if (!/^xoxb-[A-Za-z0-9-]+$/.test(token))
      throw new Error("Invalid SINK_MONITOR_SLACK_BOT_TOKEN");
    if (!channelId.safeParse(channel).success)
      throw new Error("Invalid SINK_MONITOR_SLACK_CHANNEL_ID");
    return { kind: "bot", token, channelId: channel };
  }
  const url = slackWebhook(env);
  return url ? { kind: "webhook", url } : undefined;
}

const botResponse = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    channel: channelId,
    ts: slackThreadSchema.shape.ts,
  }),
  z.object({
    ok: z.literal(false),
    error: z.string().regex(/^[a-z_]{1,64}$/),
  }),
]);

export async function postSlackMessage(input: {
  target: SlackTarget;
  text: string;
  threadTs?: string;
  post: typeof fetch;
}): Promise<
  | { kind: "webhook" }
  | { kind: "bot"; channelId: string; ts: string }
  | { kind: "rate-limited"; retryAfterMs: number }
  | { kind: "thread-missing" }
> {
  const { target, text, threadTs, post } = input;
  const response = await post(
    target.kind === "bot"
      ? "https://slack.com/api/chat.postMessage"
      : target.url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(target.kind === "bot"
          ? { Authorization: `Bearer ${target.token}` }
          : {}),
      },
      body: JSON.stringify({
        text,
        unfurl_links: false,
        unfurl_media: false,
        ...(target.kind === "bot"
          ? {
              channel: target.channelId,
              thread_ts: threadTs,
              reply_broadcast: false,
            }
          : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (target.kind === "bot" && response.status === 429) {
    const delay = Math.ceil(Number(response.headers.get("retry-after")) * 1000);
    return {
      kind: "rate-limited",
      retryAfterMs:
        Number.isSafeInteger(delay) && delay > 0 ? Math.max(1000, delay) : 1000,
    };
  }
  if (!response.ok)
    throw new SlackDeliveryError(
      "Slack delivery failed: HTTP " + response.status,
    );
  if (target.kind === "webhook") {
    if ((await response.text()).trim() !== "ok")
      throw new SlackDeliveryError("Slack webhook rejected message");
    return { kind: "webhook" };
  }
  const parsed = botResponse.safeParse(await response.json().catch(() => null));
  if (!parsed.success)
    throw new SlackDeliveryError("Invalid Slack delivery response");
  if (!parsed.data.ok) {
    if (threadTs && parsed.data.error === "thread_not_found")
      return { kind: "thread-missing" };
    throw new SlackDeliveryError("Slack delivery failed: " + parsed.data.error);
  }
  if (parsed.data.channel !== target.channelId)
    throw new SlackDeliveryError("Slack delivery channel mismatch");
  return { kind: "bot", channelId: parsed.data.channel, ts: parsed.data.ts };
}
