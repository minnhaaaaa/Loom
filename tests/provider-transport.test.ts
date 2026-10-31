import { afterEach, expect, it, vi } from "vitest";
import {
  providerFetch,
  modelIdentity,
  boundedProviderBody,
  type ProviderRuntimeConfig,
} from "../apps/web/server/provider-transport";
import {
  encryptProviderCredential,
  decryptProviderCredential,
} from "../apps/web/server/provider-config";
import { inferConversation } from "../apps/web/server/conversation-model";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const config: ProviderRuntimeConfig = {
  provider: "openai",
  key: "fixture-api-key-never-real",
  model: "fixture-model",
  maxTokens: 4096,
  timeoutMs: 1000,
  freeOnly: false,
  revision: 2,
};
const request = {
  system: "Return JSON.",
  input: "Synthetic input",
  schemaName: "loom_test",
  schema: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  },
};
it("binds encrypted credentials to their company and configuration, and detects tampering", () => {
  vi.stubEnv("LOOM_PROVIDER_ENCRYPTION_KEY", "12".repeat(32));
  const sealed = encryptProviderCredential(config.key, "company-a/openai/2");
  expect(sealed).not.toContain(config.key);
  expect(decryptProviderCredential(sealed, "company-a/openai/2")).toBe(
    config.key,
  );
  expect(() => decryptProviderCredential(sealed, "company-b/openai/2")).toThrow(
    "could not be unlocked",
  );
  const parts = sealed.split(".");
  parts[3] = (parts[3][0] === "a" ? "b" : "a") + parts[3].slice(1);
  expect(() =>
    decryptProviderCredential(parts.join("."), "company-a/openai/2"),
  ).toThrow("could not be unlocked");
  vi.stubEnv("LOOM_PROVIDER_ENCRYPTION_KEY", "");
  expect(() => encryptProviderCredential(config.key, "company-a")).toThrow(
    "deployment encryption key",
  );
});
it("uses fixed provider routes, bounded output, no storage, and no redirects for OpenAI", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({}));
  vi.stubGlobal("fetch", fetch);
  await providerFetch(config, request);
  expect(fetch.mock.calls[0][0]).toBe(
    "https://api.openai.com/v1/chat/completions",
  );
  expect(fetch.mock.calls[0][1].redirect).toBe("error");
  const body = JSON.parse(fetch.mock.calls[0][1].body);
  expect(body).toMatchObject({
    model: "fixture-model",
    max_completion_tokens: 4096,
    store: false,
    response_format: { type: "json_schema", json_schema: { strict: true } },
  });
  expect(body.provider).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain(config.key);
});
it("normalizes Anthropic tool output and truncation without executing a tool", async () => {
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      id: "fixture",
      model: "fixture-claude",
      stop_reason: "tool_use",
      content: [{ type: "tool_use", name: "loom_test", input: { ok: true } }],
      usage: { input_tokens: 3, output_tokens: 4 },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const response = await providerFetch(
    { ...config, provider: "anthropic" },
    request,
  );
  expect(await response.json()).toMatchObject({
    choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }],
    usage: { prompt_tokens: 3, completion_tokens: 4 },
  });
  expect(JSON.parse(fetch.mock.calls[0][1].body).tool_choice).toEqual({
    type: "tool",
    name: "loom_test",
  });
  expect(fetch.mock.calls[0][1].headers["x-api-key"]).toBe(config.key);
  fetch.mockResolvedValue(
    Response.json({
      id: "fixture",
      model: "fixture-claude",
      stop_reason: "max_tokens",
      content: [],
    }),
  );
  expect(
    await (
      await providerFetch({ ...config, provider: "anthropic" }, request)
    ).json(),
  ).toMatchObject({ choices: [{ finish_reason: "length" }] });
});
it("uses JSON mode for Kimi/DeepSeek and preserves provider rate-limit status", async () => {
  const fetch = vi
    .fn()
    .mockImplementation(async () =>
      Response.json(
        { error: { code: 429 } },
        { status: 429, headers: { "Retry-After": "40" } },
      ),
    );
  vi.stubGlobal("fetch", fetch);
  for (const provider of ["kimi", "deepseek"] as const) {
    const response = await providerFetch({ ...config, provider }, request);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("40");
    const body = JSON.parse(fetch.mock.lastCall![1].body);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].content).toContain('"additionalProperties":false');
  }
});
it("retains OpenRouter zero-price and privacy controls", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({}));
  vi.stubGlobal("fetch", fetch);
  await providerFetch(
    { ...config, provider: "openrouter", freeOnly: true },
    request,
  );
  expect(JSON.parse(fetch.mock.calls[0][1].body).provider).toMatchObject({
    data_collection: "deny",
    require_parameters: true,
    max_price: { prompt: 0, completion: 0, request: 0 },
  });
});
it("pins company provider revision and uses it in conversation inference", async () => {
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      id: "fixture",
      model: "actual-model",
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              reply: "Synthetic reply",
              evidenceIds: [],
              toolInstructions: null,
              proposals: [],
            }),
          },
        },
      ],
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const result = await inferConversation(
    {},
    modelIdentity(config),
    undefined,
    config,
  );
  expect(result.inference.requestedModel).toBe("openai:fixture-model@2");
  expect(result.decision.reply).toBe("Synthetic reply");
  await expect(
    inferConversation({}, "openai:fixture-model@1", undefined, config),
  ).rejects.toMatchObject({ code: "MODEL_CONFIGURATION_CHANGED" });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("rejects oversized provider output", async () => {
  await expect(
    boundedProviderBody(Response.json({ text: "x".repeat(600_000) })),
  ).rejects.toThrow("too large");
});
