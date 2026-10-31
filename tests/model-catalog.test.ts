import { afterEach, expect, it, vi } from "vitest";
import { fetchModelCatalog } from "../apps/web/server/model-catalog";

afterEach(() => vi.unstubAllGlobals());
const key = "synthetic-model-list-key";
it("keeps ChatGPT's displayable choices, names, slugs and order separate from the API catalogue", async () => {
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      models: [
        { slug: "plan-second", display_name: "Second", visibility: "list" },
        { slug: "plan-hidden", display_name: "Hidden", visibility: "hidden" },
        { slug: "plan-first", display_name: "First", visibility: "list" },
      ],
    }),
  );
  vi.stubGlobal("fetch", fetch);
  expect(await fetchModelCatalog("openai", key, true)).toEqual([
    { id: "plan-second", name: "Second" },
    { id: "plan-first", name: "First" },
  ]);
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledWith(
    "https://api.openai.com/v1/models",
    expect.objectContaining({
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
      redirect: "error",
    }),
  );
  expect(fetch.mock.calls[0][1].body).toBeUndefined();
});
it.each([
  ["openai", "https://api.openai.com/v1/models"],
  ["kimi", "https://api.moonshot.ai/v1/models"],
  ["deepseek", "https://api.deepseek.com/models"],
] as const)(
  "loads %s model IDs without an inference request",
  async (provider, url) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ data: [{ id: "model-example", name: "Example" }] }),
      );
    vi.stubGlobal("fetch", fetch);
    expect(await fetchModelCatalog(provider, key)).toEqual([
      { id: "model-example", name: "Example" },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      url,
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
  },
);
it("paginates Claude models and excludes retired entries", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        data: [{ id: "claude-a", display_name: "A" }],
        has_more: true,
        last_id: "claude-a",
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        data: [
          { id: "claude-b", display_name: "B" },
          { id: "retired", lifecycle: "retired" },
        ],
        has_more: false,
      }),
    );
  vi.stubGlobal("fetch", fetch);
  expect(await fetchModelCatalog("anthropic", key)).toEqual([
    { id: "claude-a", name: "A" },
    { id: "claude-b", name: "B" },
  ]);
  expect(fetch.mock.calls[1][0]).toBe(
    "https://api.anthropic.com/v1/models?limit=1000&after_id=claude-a",
  );
  expect(fetch.mock.calls[0][1].headers["x-api-key"]).toBe(key);
});
it("excludes non-text and shut-down OpenAI models", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        data: [
          { id: "text-model" },
          { id: "text-embedding-model" },
          { id: "gpt-image-example" },
          { id: "old-model", shutdown_date: "2020-01-01" },
        ],
      }),
    ),
  );
  expect(await fetchModelCatalog("openai", key)).toEqual([
    { id: "text-model", name: "text-model" },
  ]);
});
it.each([401, 403, 429, 500])(
  "sanitizes provider %s errors without echoing credentials or using a fallback",
  async (status) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: { message: key } }, { status }),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(fetchModelCatalog("openai", key)).rejects.toMatchObject({
      code: "MODEL_CATALOG_UNAVAILABLE",
    });
    expect(fetch).toHaveBeenCalledOnce();
  },
);
it.each([{ data: [{ id: "<script>" }] }, { models: [] }, { data: "invalid" }])(
  "fails closed on an invalid company catalogue",
  async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
    await expect(fetchModelCatalog("openai", key)).rejects.toMatchObject({
      code: "MODEL_CATALOG_UNAVAILABLE",
    });
  },
);
