import { expect, test } from "@playwright/test";

test("canonical ChatGPT requests pass Next's host normalization and reach authentication", async ({
  request,
  baseURL,
}) => {
  for (const [method, path, data] of [
    ["POST", "/api/workspaces/codex/start", {}],
    ["PATCH", "/api/workspaces/codex", { model: "test-model" }],
    ["DELETE", "/api/workspaces/codex", {}],
  ] as const) {
    const response = await request.fetch(path, {
      method,
      headers: { origin: baseURL! },
      data,
    });
    expect(response.status()).toBe(401);
    expect((await response.json()).error.code).toBe("UNAUTHENTICATED");
  }
});

test("ChatGPT writes reject the localhost alias and foreign origins despite forwarded headers", async ({
  request,
  baseURL,
}) => {
  const alias = new URL(baseURL!);
  alias.hostname = "localhost";
  const response = await request.post("/api/workspaces/codex/start", {
    headers: {
      host: alias.host,
      origin: baseURL!,
      "x-forwarded-host": new URL(baseURL!).host,
      "x-forwarded-proto": "http",
    },
    data: {},
  });
  expect(response.status()).toBe(409);
  expect((await response.json()).error.code).toBe("OPENAI_CANONICAL_ORIGIN");
  const foreign = await request.post("/api/workspaces/codex/start", {
    headers: { origin: "https://foreign.example" },
    data: {},
  });
  expect(foreign.status()).toBe(403);
  expect((await foreign.json()).error.code).toBe("INVALID_ORIGIN");
});
