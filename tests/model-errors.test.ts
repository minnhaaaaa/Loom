import { expect, it, vi } from "vitest";
import { modelResponseError } from "../apps/web/server/model-errors";
import { endpoint } from "../apps/web/server/http";
import { DomainError } from "@loom/domain";

it("classifies HTTP and body-level provider failures without exposing upstream diagnostics", () => {
  const error = modelResponseError(new Response(null, { status: 200 }), {
    error: {
      type: "rate_limit_exceeded",
      message: "Private account/provider diagnostic",
    },
  })!;
  expect(error).toMatchObject({
    code: "MODEL_HTTP_429",
    status: 429,
    details: { retryAfterSeconds: 60, retryable: true },
  });
  expect(error.message).not.toContain("Private account");
  expect(
    modelResponseError(new Response(null, { status: 200 }), {
      choices: [{ message: { content: "valid" } }],
    }),
  ).toBeNull();
  expect(
    modelResponseError(new Response(null, { status: 401 }), {}),
  ).toMatchObject({ code: "MODEL_HTTP_401", details: { retryable: false } });
});

it("accepts date retry headers and bounds invalid or very large provider delays", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-27T00:00:00Z"));
  try {
    expect(
      modelResponseError(
        new Response(null, {
          status: 429,
          headers: { "Retry-After": "Tue, 27 Oct 2026 00:01:30 GMT" },
        }),
        {},
      )?.details?.retryAfterSeconds,
    ).toBe(90);
    expect(
      modelResponseError(
        new Response(null, {
          status: 429,
          headers: { "Retry-After": "999999999" },
        }),
        {},
      )?.details?.retryAfterSeconds,
    ).toBe(86400);
    expect(
      modelResponseError(
        new Response(null, {
          status: 429,
          headers: { "Retry-After": "invalid" },
        }),
        {},
      )?.details?.retryAfterSeconds,
    ).toBe(60);
  } finally {
    vi.useRealTimers();
  }
});

it("returns a private API error with the same Retry-After delay the builder receives", async () => {
  const route = endpoint(async () => {
    throw new DomainError("MODEL_HTTP_429", "Retry later.", 429, {
      retryAfterSeconds: 90,
      retryable: true,
    });
  });
  const result = await route(new Request("http://localhost/api/tool/generate"));
  expect(result.status).toBe(429);
  expect(result.headers.get("Retry-After")).toBe("90");
  expect(result.headers.get("Cache-Control")).toContain("no-store");
  expect((await result.json()).error).toMatchObject({
    code: "MODEL_HTTP_429",
    retryAfterSeconds: 90,
    retryable: true,
  });
});

it("explains ChatGPT plan limits without inventing a reset time or exposing diagnostics", () => {
  const error = modelResponseError(
    new Response(null, { status: 429 }),
    {
      error: {
        code: "subscription_sharing_usage_limit_exceeded",
        type: "invalid_request_error",
        message: "Private plan diagnostic",
      },
    },
    "openai-chatgpt",
  )!;
  expect(error.code).toBe("MODEL_HTTP_429");
  expect(error.message).toContain("ChatGPT settings → Usage");
  expect(error.message).not.toMatch(/Private|API key|entire plan|reset/i);
  expect(error.details).toEqual({ retryable: false });
});

it.each([
  ["subscription_sharing_user_not_eligible", 403, false, "eligibility"],
  ["subscription_sharing_usage_unavailable", 503, true, "Keep this connection"],
  [
    "subscription_sharing_unsupported_capability",
    400,
    false,
    "supported model",
  ],
  ["subscription_sharing_route_not_supported", 403, false, "inference route"],
  ["subscription_sharing_invalid_user", 401, false, "Reconnect your ChatGPT"],
  ["chatpass_v2_scope_not_authorized", 403, false, "permission configuration"],
  [
    "chatpass_v2_invalid_authorization_context",
    403,
    false,
    "permission configuration",
  ],
  ["subscription_sharing_user_unavailable", 503, true, "Keep this connection"],
] as const)(
  "handles %s with its documented recovery and no billing fallback",
  (code, status, retryable, message) => {
    const error = modelResponseError(new Response(null, { status }), {
      error: { code, message: "Private diagnostic" },
    })!;
    expect(error.code).toBe(`MODEL_HTTP_${status}`);
    expect(error.message).toContain(message);
    expect(error.message).not.toMatch(/Private|API key|paid API/i);
    expect(error.details).toEqual({ retryable });
  },
);

it("uses ChatGPT recovery for admission failures without a structured error object", () => {
  for (const body of [{ detail: "Private admission diagnostic" }, {}]) {
    const error = modelResponseError(
      new Response(null, { status: 401 }),
      body,
      "openai-chatgpt",
    )!;
    expect(error.code).toBe("OPENAI_RECONNECT_REQUIRED");
    expect(error.message).toContain("Reconnect your ChatGPT account");
    expect(error.message).not.toMatch(/Private|API key/);
  }
  const unavailable = modelResponseError(
    new Response(null, { status: 503 }),
    { detail: "Private" },
    "openai-chatgpt",
  )!;
  expect(unavailable.message).toContain("Keep this connection");
  expect(unavailable.details?.retryable).toBe(true);
});

it("marks only a confirmed personal ChatGPT authorization rejection for reconnection", () => {
  for (const status of [200, 401, 403]) {
    const body = { error: { code: "subscription_sharing_invalid_user" } };
    expect(
      modelResponseError(new Response(null, { status }), body, "openai-chatgpt")
        ?.code,
    ).toBe("OPENAI_RECONNECT_REQUIRED");
    expect(
      modelResponseError(new Response(null, { status }), body, "openai")?.code,
    ).not.toBe("OPENAI_RECONNECT_REQUIRED");
  }
  for (const status of [400, 403, 429, 500, 503]) {
    expect(
      modelResponseError(new Response(null, { status }), {}, "openai-chatgpt")
        ?.code,
    ).not.toBe("OPENAI_RECONNECT_REQUIRED");
  }
});

it("uses only explicit retry headers for ChatGPT and keeps actual HTTP status", () => {
  const response = new Response(null, {
    status: 429,
    headers: { "Retry-After": "45" },
  });
  expect(modelResponseError(response, {}, "openai-chatgpt")?.details).toEqual({
    retryable: true,
    retryAfterSeconds: 45,
  });
  expect(
    modelResponseError(
      new Response(null, { status: 429 }),
      {},
      "openai-chatgpt",
    )?.details,
  ).toEqual({ retryable: true });
  expect(
    modelResponseError(
      new Response(null, { status: 403 }),
      { error: { code: "subscription_sharing_usage_limit_exceeded" } },
      "openai-chatgpt",
    )?.code,
  ).toBe("MODEL_HTTP_403");
});
