import { afterEach, expect, it, vi } from "vitest";
import {
  discord,
  discordOptions,
  discordPage,
} from "../apps/web/server/discord-source";
const channel = "123456789012345678",
  guild = "223456789012345678",
  bot = "323456789012345678",
  user = "423456789012345678";
const config = {
  rootId: channel,
  parentId: guild,
  name: "#analytics",
  accountId: bot,
  requestMode: "detect" as const,
};
function message(
  id = "523456789012345678",
  content = "Can you compare revenue by region for this quarter?",
) {
  return {
    id,
    channel_id: channel,
    type: 0,
    timestamp: new Date().toISOString(),
    content,
    author: { id: user, username: "analyst" },
  };
}
function mock(
  messages: unknown[] = [message()],
  overrides: Record<string, unknown> = {},
) {
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    expect(url.origin).toBe("https://discord.com");
    expect(init?.redirect).toBe("manual");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bot synthetic",
    );
    const data: Record<string, unknown> = {
      "/api/v10/applications/@me": { flags_new: String(1 << 19) },
      [`/api/v10/channels/${channel}`]: {
        id: channel,
        guild_id: guild,
        type: 0,
      },
      [`/api/v10/channels/${channel}/permissions/member/${bot}`]: {
        permissions: "66560",
      },
      [`/api/v10/channels/${channel}/messages`]: messages,
      ...overrides,
    };
    if (!(url.pathname in data))
      throw new Error(`Unexpected route ${url.pathname}`);
    return Response.json(data[url.pathname]);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
afterEach(() => vi.unstubAllGlobals());
it("detects human analytics requests and retains their original Discord links", async () => {
  mock([
    message(),
    { ...message("623456789012345678"), author: { id: bot, bot: true } },
  ]);
  const page = await discordPage("synthetic", config, null);
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({
    url: `https://discord.com/channels/${guild}/${channel}/523456789012345678`,
    author: "analyst",
    detection: { decision: "request" },
  });
});
it("does not duplicate an original ask when a reply only says thanks", async () => {
  const original = message();
  mock([
    {
      ...message("623456789012345678", "Thanks!"),
      type: 19,
      message_reference: { channel_id: channel, message_id: original.id },
      referenced_message: original,
    },
  ]);
  const page = await discordPage("synthetic", config, null);
  expect(page.items[0].detection?.decision).not.toBe("request");
});
it("never includes quoted reply context from another channel", async () => {
  mock([
    {
      ...message(),
      type: 19,
      message_reference: {
        channel_id: guild,
        message_id: "623456789012345678",
      },
      referenced_message: {
        ...message("623456789012345678", "private text"),
        channel_id: guild,
      },
    },
  ]);
  const page = await discordPage("synthetic", config, null);
  expect(page.items[0].text).not.toContain("private text");
});
it("checks intent and computed channel permissions instead of reporting an empty successful import", async () => {
  const fetch = mock([], { "/api/v10/applications/@me": { flags: 0 } });
  await expect(discordPage("synthetic", config, null)).rejects.toThrow(
    "Message Content Intent",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  mock([], {
    [`/api/v10/channels/${channel}/permissions/member/${bot}`]: {
      permissions: "1024",
    },
  });
  await expect(discordPage("synthetic", config, null)).rejects.toThrow(
    "Read Message History",
  );
});
it("refuses channels outside the selected server and separate threads", async () => {
  for (const value of [
    { id: channel, guild_id: bot, type: 0 },
    { id: channel, guild_id: guild, type: 11 },
  ]) {
    mock([], { [`/api/v10/channels/${channel}`]: value });
    await expect(discordPage("synthetic", config, null)).rejects.toMatchObject({
      code: "SOURCE_SCOPE",
    });
  }
});
it("advances snowflake checkpoints and stops at the 30-day boundary", async () => {
  const rows = Array.from({ length: 100 }, (_, index) =>
    message(String(523456789012345678n + BigInt(index))),
  );
  mock(rows);
  const page = await discordPage("synthetic", config, null);
  expect(page.cursor?.next).toBe("523456789012345678");
  mock([
    {
      ...message(),
      timestamp: new Date(Date.now() - 31 * 86400000).toISOString(),
    },
  ]);
  expect((await discordPage("synthetic", config, null)).items).toHaveLength(0);
});
it("lists only supported channels and obeys bot-wide retry delays", async () => {
  mock([], {
    [`/api/v10/guilds/${guild}/channels`]: [
      { id: channel, name: "analytics", type: 0 },
      { id: bot, name: "forum", type: 15 },
    ],
  });
  expect(await discordOptions("synthetic", guild)).toEqual([
    { id: channel, name: "#analytics" },
  ]);
  const fetch = vi.fn(async () =>
    Response.json({ retry_after: 20 }, { status: 429 }),
  );
  vi.stubGlobal("fetch", fetch);
  await expect(discord("rate-discord", "users/@me")).rejects.toMatchObject({
    retrySeconds: 20,
  });
  await expect(discord("rate-discord", "applications/@me")).rejects.toThrow(
    "rate limit",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});
