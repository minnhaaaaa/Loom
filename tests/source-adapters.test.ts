import { afterEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import {
  fetchSourcePage,
  validateSource,
} from "../apps/web/server/source-adapters";
import {
  bytes,
  documentText,
  downloadDocument,
  graphUrl,
  plainText,
  slack,
  SourceError,
} from "../apps/web/server/source-transport";

afterEach(() => vi.unstubAllGlobals());
it("extracts Word text without evaluating markup or opening other archive entries", () => {
  const { zipSync, strToU8 } = createRequire(
    new URL("../apps/web/package.json", import.meta.url),
  )("fflate");
  const archive = zipSync({
    "word/document.xml": strToU8(
      "<w:document><w:p><w:r><w:t>Net revenue &amp; refunds</w:t></w:r></w:p><w:p><w:r><w:t>Use the ledger.</w:t></w:r></w:p></w:document>",
    ),
    "unrelated.xml": strToU8("Ignored"),
  });
  expect(documentText(archive, "Definition.docx")).toBe(
    "Net revenue & refunds\nUse the ledger.",
  );
});
const config = {
  rootId: "CINTAKE",
  parentId: "",
  name: "#analytics",
  accountId: "TEXAMPLE",
};
it("imports a Slack thread once, skips bots/system/reply messages, and preserves its source link", async () => {
  const fetch = vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.pathname.endsWith("conversations.history"))
      return Response.json({
        ok: true,
        messages: [
          {
            ts: "1700000000.123456",
            user: "UALICE",
            text: "Why did revenue drop?",
            reply_count: 1,
          },
          {
            ts: "1700000001.1",
            user: "UBOB",
            text: "Reply",
            thread_ts: "1700000000.123456",
          },
          { ts: "1700000002.1", bot_id: "B1", text: "Notification" },
          {
            ts: "1700000003.1",
            user: "U1",
            subtype: "channel_join",
            text: "joined",
          },
        ],
        response_metadata: { next_cursor: "next-page" },
      });
    if (url.pathname.endsWith("conversations.replies"))
      return Response.json({
        ok: true,
        messages: [
          { ts: "1700000000.123456", text: "Why did revenue drop?" },
          { ts: "1700000001.1", user: "UBOB", text: "October, please." },
        ],
      });
    return Response.json({
      ok: true,
      permalink: "https://fixture.slack.com/archives/CINTAKE/p1700000000123456",
    });
  });
  vi.stubGlobal("fetch", fetch);
  const page = await fetchSourcePage("slack", "secret", config, null);
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({
    id: "1700000000.123456",
    author: "UALICE",
    truncated: false,
  });
  expect(page.items[0].text).toContain("October, please.");
  expect(page.cursor?.next).toBe("next-page");
  expect(fetch).toHaveBeenCalledTimes(3);
});
it("refuses private Slack channels before fetching their history", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ ok: true, channel: { id: "CINTAKE", is_private: true } }),
    ),
  );
  await expect(
    validateSource(
      "secret",
      {
        provider: "slack",
        rootId: "CINTAKE",
        parentId: "",
        shareWithWorkspace: true,
      },
      "TEXAMPLE",
    ),
  ).rejects.toMatchObject({ code: "SOURCE_SCOPE" });
});
it("normalizes Teams HTML and marks bounded reply excerpts", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        value: [
          {
            id: "m1",
            messageType: "message",
            from: { user: { id: "u1", displayName: "Alice" } },
            body: {
              contentType: "html",
              content: "<p>Revenue &amp; returns</p><script>bad()</script>",
            },
            webUrl: "https://teams.microsoft.com/l/message/m1",
            lastModifiedDateTime: "2026-10-31T10:00:00Z",
            replies: [
              {
                body: { content: "<p>Use October</p>" },
                from: { user: { displayName: "Bob" } },
              },
            ],
            "replies@odata.nextLink": "https://graph.microsoft.com/v1.0/more",
          },
        ],
      }),
    ),
  );
  const page = await fetchSourcePage(
    "teams",
    "secret",
    { ...config, parentId: "team1" },
    null,
  );
  expect(page.items[0].text).toBe("Revenue & returns\n\nBob: Use October");
  expect(page.items[0].truncated).toBe(true);
});
it("rejects foreign and cross-resource pagination links before sending tokens", () => {
  expect(() => graphUrl("https://attacker.example/capture")).toThrow(
    SourceError,
  );
  expect(() =>
    graphUrl(
      "https://graph.microsoft.com/v1.0/me/messages",
      "drives/d1/root/delta",
    ),
  ).toThrow(SourceError);
  expect(
    graphUrl(
      "https://graph.microsoft.com/v1.0/drives/d1/root/delta?$deltatoken=abc",
      "drives/d1/root/delta",
    ),
  ).toContain("$deltatoken=abc");
});
it("does not forward Microsoft authorization to a SharePoint download", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          location: "https://fixture.sharepoint.com/download?token=opaque",
        },
      }),
    )
    .mockResolvedValueOnce(new Response("Reference content"));
  vi.stubGlobal("fetch", fetch);
  expect(
    Buffer.from(
      await downloadDocument("private-token", "drive1", "file1"),
    ).toString(),
  ).toBe("Reference content");
  expect(fetch.mock.calls[0][1].headers.Authorization).toBe(
    "Bearer private-token",
  );
  expect(fetch.mock.calls[1][1].headers).toBeUndefined();
  expect(fetch.mock.calls[1][1].redirect).toBe("manual");
});
it("refuses download redirects to arbitrary hosts", async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/private" },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  await expect(
    downloadDocument("private-token", "drive1", "file1"),
  ).rejects.toThrow("unsupported download address");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("tracks SharePoint deletions and unsupported files without inventing text", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        value: [
          { id: "gone", deleted: {} },
          { id: "pdf", name: "scan.pdf", file: {}, size: 50 },
        ],
        "@odata.deltaLink":
          "https://graph.microsoft.com/v1.0/drives/CINTAKE/root/delta?$deltatoken=cursor",
      }),
    ),
  );
  const page = await fetchSourcePage("sharepoint", "secret", config, null);
  expect(page.items[0].deleted).toBe(true);
  expect(page.items[1].skip).toBe(true);
  expect(page.cursor?.next).toContain("deltatoken=cursor");
});
it("honors rate limits without displaying provider response content", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response("private upstream response", {
          status: 429,
          headers: { "retry-after": "123" },
        }),
    ),
  );
  await expect(slack("private-token", "auth.test")).rejects.toMatchObject({
    retrySeconds: 123,
  });
  try {
    await slack("private-token", "auth.test");
  } catch (error) {
    expect((error as Error).message).not.toContain("private");
  }
});
it("bounds streaming response sizes and treats markup as plain text", async () => {
  await expect(bytes(new Response("123456"), 5)).rejects.toThrow("too large");
  expect(
    plainText("<p>A &#x26; B</p><style>bad</style><p>&lt;example&gt;</p>"),
  ).toBe("A & B\n<example>");
});
