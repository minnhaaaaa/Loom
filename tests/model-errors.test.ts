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
