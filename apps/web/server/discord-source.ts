import "server-only";
import { createHash } from "node:crypto";
import { DomainError } from "@loom/domain";
import type { SourceOption } from "@loom/contracts";
import {
  bytes,
  jsonResponse,
  object,
  objects,
  sourceFetch,
  SourceError,
  string,
  type Json,
} from "./source-transport";
import {
  detectRequest,
  detectionVersion,
  type ChatMessage,
} from "./request-detection";
import type {
  SourceConfig,
  SourceCursor,
  SourcePage,
  SourceItem,
} from "./source-adapters";

const snowflake = /^\d{17,20}$/;
const cooldowns = new Map<string, number>();
export function discordId(value: string) {
  if (!snowflake.test(value))
    throw new DomainError(
      "SOURCE_SCOPE",
      "Choose a Discord server and channel from the list.",
      422,
    );
  return value;
}
/** Fixed-origin, GET-only bot API. Never follows provider redirects. */
export async function discord(
  token: string,
  path: string,
  query: Record<string, string> = {},
): Promise<unknown> {
  if (
    !/^(users\/@me(?:\/guilds)?|applications\/@me|guilds\/\d{17,20}\/channels|channels\/\d{17,20}(?:\/messages|\/permissions\/member\/\d{17,20})?)$/.test(
      path,
    )
  )
    throw new SourceError("Invalid Discord resource.");
  const key = createHash("sha256").update(token).digest("hex"),
    now = Date.now();
  for (const [entry, until] of cooldowns)
    if (until <= now) cooldowns.delete(entry);
  const until = cooldowns.get(key) || 0;
  if (until > now)
    throw new SourceError(
      "Discord paused sync because of its rate limit. Loom will retry.",
      Math.ceil((until - now) / 1000),
    );
  const url = new URL(`https://discord.com/api/v10/${path}`);
  url.search = new URLSearchParams(query).toString();
  const response = await sourceFetch(url.href, {
    headers: {
      Authorization: `Bot ${token}`,
      "User-Agent": "DiscordBot (https://github.com/minnhaaaaa/Loom, 0.1.0)",
    },
  });
  if (response.status === 429) {
    let body: Json = {};
    try {
      body = object(
        JSON.parse(Buffer.from(await bytes(response, 64000)).toString("utf8")),
      );
    } catch {
      /* Use the header or bounded default. */
    }
    const seconds = Math.max(
      Number(response.headers.get("retry-after")) || 0,
      Number(body.retry_after) || 0,
      1,
    );
    const retry = Number.isFinite(seconds) ? Math.ceil(seconds) : 300;
    cooldowns.set(key, now + retry * 1000);
    throw new SourceError(
      "Discord paused sync because of its rate limit. Loom will retry.",
      retry,
    );
  }
  if (!response.ok) {
    await jsonResponse(response);
    throw new SourceError("Discord is unavailable.");
  }
  if (response.headers.get("x-ratelimit-remaining") === "0") {
    const seconds = Number(response.headers.get("x-ratelimit-reset-after"));
    if (Number.isFinite(seconds) && seconds > 0)
      cooldowns.set(key, Date.now() + seconds * 1000);
  }
  try {
    return JSON.parse(Buffer.from(await bytes(response)).toString("utf8"));
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError("Discord returned an unreadable response.");
  }
}
function flagBits(value: unknown): bigint {
  const text =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : string(value);
  return /^\d{1,30}$/.test(text) ? BigInt(text) : 0n;
}
export async function discordApplication(token: string) {
  const app = object(await discord(token, "applications/@me"));
  const flags = flagBits(app.flags_new ?? app.flags);
  if (!(flags & ((1n << 18n) | (1n << 19n))))
    throw new SourceError(
      "Enable Message Content Intent on your Discord app’s Bot page, then connect again.",
      900,
      "SOURCE_ACCESS",
    );
  return app;
}
export async function discordChannel(
  token: string,
  channelId: string,
  guildId: string,
  botId: string,
) {
  const channel = object(
    await discord(token, `channels/${discordId(channelId)}`),
  );
  if (
    channel.id !== channelId ||
    channel.guild_id !== discordId(guildId) ||
    ![0, 5].includes(Number(channel.type))
  )
    throw new DomainError(
      "SOURCE_SCOPE",
      "Choose a text or announcement channel in the selected Discord server.",
      422,
    );
  const permissions = object(
    await discord(
      token,
      `channels/${channelId}/permissions/member/${discordId(botId)}`,
    ),
  );
  const required = (1n << 10n) | (1n << 16n),
    bits = flagBits(permissions.permissions);
  if (!(bits & 8n) && (bits & required) !== required)
    throw new SourceError(
      "Give the Discord bot View Channel and Read Message History permissions for this channel.",
      900,
      "SOURCE_ACCESS",
    );
  return channel;
}
export async function discordOptions(
  token: string,
  parentId: string,
): Promise<SourceOption[]> {
  if (parentId) {
    const result = await discord(
      token,
      `guilds/${discordId(parentId)}/channels`,
    );
    if (!Array.isArray(result))
      throw new SourceError("Discord did not return its channel list.");
    return objects(result)
      .filter(
        (channel) =>
          snowflake.test(string(channel.id)) &&
          [0, 5].includes(Number(channel.type)),
      )
      .map((channel) => ({
        id: string(channel.id),
        name: `#${string(channel.name)}`,
      }));
  }
  const guilds: SourceOption[] = [];
  let after = "";
  for (let page = 0; page < 10; page++) {
    const result = await discord(token, "users/@me/guilds", {
      limit: "200",
      ...(after ? { after } : {}),
    });
    if (!Array.isArray(result))
      throw new SourceError("Discord did not return its server list.");
    const rows = objects(result);
    for (const guild of rows)
      guilds.push({
        id: discordId(string(guild.id)),
        name: string(guild.name),
      });
    if (rows.length < 200) return guilds;
    const next = rows
      .map((row) => discordId(string(row.id)))
      .reduce((max, id) => (BigInt(id) > BigInt(max) ? id : max), "0");
    if (after && BigInt(next) <= BigInt(after))
      throw new SourceError("Discord returned an invalid server checkpoint.");
    after = next;
  }
  throw new SourceError(
    "This bot belongs to too many servers. Use a bot dedicated to your team.",
  );
}
const authorName = (message: Json) =>
  string(object(message.author).global_name) ||
  string(object(message.author).username) ||
  string(object(message.author).id);
const human = (message: Json) =>
  !object(message.author).bot &&
  !object(message.author).system &&
  !message.webhook_id &&
  snowflake.test(string(object(message.author).id)) &&
  [0, 19].includes(Number(message.type));
export async function discordPage(
  token: string,
  config: SourceConfig,
  cursor: SourceCursor | null,
): Promise<SourcePage> {
  await discordApplication(token);
  await discordChannel(token, config.rootId, config.parentId, config.accountId);
  const oldest =
    cursor?.oldest || new Date(Date.now() - 30 * 86400_000).toISOString();
  if (!Number.isFinite(Date.parse(oldest)))
    throw new SourceError("Invalid Discord history checkpoint.");
  const upper =
    cursor?.next || String((BigInt(Date.now() + 1) - 1420070400000n) << 22n);
  const result = await discord(token, `channels/${config.rootId}/messages`, {
    limit: "100",
    before: discordId(upper),
  });
  if (!Array.isArray(result))
    throw new SourceError("Discord did not return its messages.");
  const rows = objects(result),
    items: SourceItem[] = [];
  let next = upper,
    reachedOldest = false;
  for (const message of rows) {
    const id = discordId(string(message.id));
    if (message.channel_id !== config.rootId || BigInt(id) >= BigInt(upper))
      throw new SourceError(
        "Discord returned messages outside the selected history page.",
      );
    if (BigInt(id) < BigInt(next)) next = id;
    const timestamp = Date.parse(string(message.timestamp));
    if (!Number.isFinite(timestamp))
      throw new SourceError("Discord returned an invalid message timestamp.");
    if (timestamp < Date.parse(oldest)) {
      reachedOldest = true;
      continue;
    }
    const text = string(message.content).trim();
    if (!human(message) || !text) continue;
    const own: ChatMessage = { id, text, author: authorName(message) };
    const context = object(message.referenced_message),
      reference = object(message.message_reference);
    const messages: ChatMessage[] = [];
    if (
      message.type === 19 &&
      reference.channel_id === config.rootId &&
      context.channel_id === config.rootId &&
      context.id === reference.message_id &&
      human(context) &&
      string(context.content)
    )
      messages.push({
        id: string(context.id),
        text: string(context.content),
        author: authorName(context),
      });
    messages.push(own);
    const content =
      text +
      (messages.length > 1
        ? `\n\nReply context — ${messages[0].author}: ${messages[0].text}`
        : "");
    const detection =
      config.requestMode === "detect" ? detectRequest(messages, id) : null;
    items.push({
      id,
      title: text.replace(/\s+/g, " ").slice(0, 160),
      text: content
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
        .slice(0, 3800),
      url: `https://discord.com/channels/${config.parentId}/${config.rootId}/${id}`,
      author: own.author.slice(0, 160),
      updatedAt: (
        string(message.edited_timestamp) || string(message.timestamp)
      ).slice(0, 80),
      truncated: content.length > 3800,
      ...(detection
        ? {
            detection: {
              decision: detection.decision,
              reason: detection.reason,
              version: detectionVersion,
            },
          }
        : {}),
    });
  }
  return {
    items,
    cursor: rows.length === 100 && !reachedOldest ? { next, oldest } : null,
  };
}
