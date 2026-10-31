import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "../apps/web/node_modules/next/server.js";
import { GET } from "../apps/web/app/api/oauth/openai/callback/route";

const boundary = vi.hoisted(() => ({
  complete: vi.fn(),
  getCookie: vi.fn(),
  setCookie: vi.fn(),
}));
vi.mock("../apps/web/node_modules/next/headers.js", () => ({
  cookies: async () => ({ get: boundary.getCookie, set: boundary.setCookie }),
}));
vi.mock("../apps/web/server/openai-oauth-store", () => ({
  completeOpenAiConnection: boundary.complete,
}));

const origin = "http://127.0.0.1:3000";
const callbackPath = "/api/oauth/openai/callback";
const query =
  "?code=synthetic%2Bcode%2Fvalue%3D&state=synthetic%2Bstate&client_id=oaiapp_fixture";

beforeEach(() => {
  vi.stubEnv("__NEXT_NO_MIDDLEWARE_URL_NORMALIZE", "");
  vi.stubEnv("LOOM_OPENAI_LOCAL_ENABLED", "true");
  vi.stubEnv("APP_ORIGIN", origin);
  vi.stubEnv("LOOM_PROVIDER_ENCRYPTION_KEY", "a".repeat(64));
  boundary.complete.mockReset().mockResolvedValue(true);
  boundary.getCookie
    .mockReset()
    .mockReturnValue({ value: "synthetic-binding" });
  boundary.setCookie.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

it("restores the verified callback host after real NextRequest normalization without changing OAuth parameters", async () => {
  const request = new NextRequest(`${origin}${callbackPath}${query}`, {
    headers: { host: "127.0.0.1:3000" },
  });
  expect(new URL(request.url).origin).toBe("http://localhost:3000");
  expect(request.headers.has("origin")).toBe(false);

  const response = await GET(request);
  expect(boundary.complete).toHaveBeenCalledExactlyOnceWith(
    new URL(`${origin}${callbackPath}${query}`),
    "synthetic-binding",
  );
  const forwarded = boundary.complete.mock.calls[0][0] as URL;
  expect(forwarded.pathname).toBe(callbackPath);
  expect(forwarded.search).toBe(query);
  expect(forwarded.searchParams.get("code")).toBe("synthetic+code/value=");
  expect(boundary.setCookie).toHaveBeenCalledExactlyOnceWith(
    "loom_openai_oauth",
    "",
    {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: callbackPath,
      maxAge: 0,
    },
  );
  const html = await response.text();
  expect(html).toContain("Your ChatGPT plan is authorized");
  expect(html).toContain('href="/app?view=settings#codex-connection"');
  expect(html).not.toContain("synthetic");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("cache-control")).toContain("no-store");
});

it.each([
  ["missing host", {}],
  ["localhost alias", { host: "localhost:3000" }],
  ["wrong port", { host: "127.0.0.1:3001" }],
  ["external host", { host: "example.test:3000" }],
  [
    "forwarded-host substitution",
    {
      host: "example.test:3000",
      "x-forwarded-host": "127.0.0.1:3000",
      "x-forwarded-proto": "http",
    },
  ],
] as const)(
  "rejects %s before consuming the OAuth transaction",
  async (_label, headers) => {
    const request = new NextRequest(`${origin}${callbackPath}${query}`, {
      headers,
    });
    const response = await GET(request);
    expect(boundary.complete).not.toHaveBeenCalled();
    expect(await response.text()).toContain("Connection not completed");
  },
);
