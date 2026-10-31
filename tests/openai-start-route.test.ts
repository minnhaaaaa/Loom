import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({
  start: vi.fn(),
  setCookie: vi.fn(),
  actor: { workspaceId: "", userId: "" },
}));
vi.mock("../apps/web/node_modules/next/headers.js", () => ({
  cookies: async () => ({
    get: () => ({ value: "synthetic-session" }),
    set: boundary.setCookie,
  }),
}));
vi.mock("../apps/web/server/http", async (original) => ({
  ...(await original<typeof import("../apps/web/server/http")>()),
  requireActor: async () => boundary.actor,
}));
vi.mock("../apps/web/server/openai-oauth-store", () => ({
  startOpenAiConnection: boundary.start,
}));
import { POST } from "../apps/web/app/api/workspaces/codex/start/route";
const origin = "http://127.0.0.1:3000";
beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", origin);
  vi.stubEnv("LOOM_OPENAI_LOCAL_ENABLED", "true");
  vi.stubEnv("LOOM_PROVIDER_ENCRYPTION_KEY", "a".repeat(64));
  boundary.actor = { workspaceId: randomUUID(), userId: randomUUID() };
  boundary.setCookie.mockReset();
  boundary.start.mockReset().mockResolvedValue({
    authorizationUrl:
      "https://auth.openai.com/api/accounts/authorize?prompt=consent",
    browserToken: "synthetic-binding",
    secure: false,
  });
});
afterEach(() => vi.unstubAllEnvs());
function request(body: object, overrides: Record<string, string> = {}) {
  return new Request(`${origin}/api/workspaces/codex/start`, {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000",
      Origin: origin,
      "Content-Type": "application/json",
      "X-Loom-Workspace": boundary.actor.workspaceId,
      ...overrides,
    },
    body: JSON.stringify(body),
  });
}
it("forwards the explicit plan consent choice without exposing the session or browser binding", async () => {
  const selection = { clientId: "oaiapp_saved", requestPlanAccess: true };
  const response = await POST(request(selection));
  expect(response.status).toBe(200);
  expect(boundary.start).toHaveBeenCalledExactlyOnceWith(
    boundary.actor,
    "synthetic-session",
    selection,
  );
  expect(await response.json()).toEqual({
    authorizationUrl:
      "https://auth.openai.com/api/accounts/authorize?prompt=consent",
  });
  expect(boundary.setCookie).toHaveBeenCalledWith(
    "loom_openai_oauth",
    "synthetic-binding",
    expect.objectContaining({
      httpOnly: true,
      path: "/api/oauth/openai/callback",
      sameSite: "lax",
    }),
  );
});
it("rejects cross-origin, cross-workspace and malformed consent requests before starting OAuth", async () => {
  expect(
    (
      await POST(
        request(
          { requestPlanAccess: true },
          { Origin: "https://example.test" },
        ),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await POST(
        request(
          { requestPlanAccess: true },
          { "X-Loom-Workspace": randomUUID() },
        ),
      )
    ).status,
  ).toBe(409);
  expect((await POST(request({ requestPlanAccess: "yes" }))).status).toBe(422);
  expect(boundary.start).not.toHaveBeenCalled();
});
