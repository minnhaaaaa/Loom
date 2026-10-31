import { createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { personas, secondWorkspaceId, workspaceId } from "@loom/contracts";
import { actorFromCookie, startSession } from "../apps/web/server/http";

const boundary = vi.hoisted(() => ({
  values: new Map<string, string>(),
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
  revokeSession: vi.fn(),
  sessionActor: vi.fn(),
}));
vi.mock("../apps/web/node_modules/next/headers.js", () => ({
  cookies: async () => boundary,
}));
vi.mock("../apps/web/server/accounts", () => ({
  accountContext: vi.fn(),
  sessionActor: boundary.sessionActor,
  revokeSession: boundary.revokeSession,
  selectSessionWorkspace: vi.fn(),
}));
const secret = "public-session-test-secret-with-at-least-32-characters";
const existingToken = "a".repeat(43);
function configure(mode: "workspace" | "local-demo") {
  vi.stubEnv("LOOM_AUTH_MODE", mode);
  vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3000");
  vi.stubEnv("LOOM_SESSION_SECRET", secret);
  vi.stubEnv("LOOM_ALLOW_DEMO_PRODUCTION", "true");
}
function expectUnchangedAccount() {
  expect(boundary.values.get("loom_session")).toBe(existingToken);
  expect(boundary.values.get("loom_demo_session")).toBe("previous-demo-cookie");
  expect(boundary.revokeSession).not.toHaveBeenCalled();
  expect(boundary.delete).not.toHaveBeenCalled();
  expect(boundary.set).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
  boundary.values.clear();
  boundary.values.set("loom_session", existingToken);
  boundary.values.set("loom_demo_session", "previous-demo-cookie");
  boundary.get.mockReset().mockImplementation((name: string) => {
    const value = boundary.values.get(name);
    return value === undefined ? undefined : { name, value };
  });
  boundary.set.mockReset().mockImplementation((name: string, value: string) => {
    boundary.values.set(name, value);
  });
  boundary.delete.mockReset().mockImplementation((name: string) => {
    boundary.values.delete(name);
  });
  boundary.revokeSession.mockReset().mockResolvedValue(undefined);
  boundary.sessionActor.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("rejects demo sign-in in workspace mode without revoking the account or changing its cookies", async () => {
  configure("workspace");
  await expect(startSession(personas[0].id)).rejects.toMatchObject({
    code: "DEMO_DISABLED",
    status: 403,
  });
  expectUnchangedAccount();
});

it("rejects an invalid demo persona without logging out the current identity", async () => {
  configure("local-demo");
  await expect(
    startSession("ffffffff-ffff-4fff-8fff-ffffffffffff"),
  ).rejects.toMatchObject({ code: "INVALID_PERSONA", status: 422 });
  expectUnchangedAccount();
});

it("validates signing configuration before replacing the current account session", async () => {
  configure("local-demo");
  vi.stubEnv("LOOM_SESSION_SECRET", "too-short");
  await expect(startSession(personas[0].id)).rejects.toMatchObject({
    code: "SESSION_CONFIGURATION",
  });
  expectUnchangedAccount();
});

it("intentionally switches a valid persona, revokes the old credential token, and installs an HTTP-only scoped signature", async () => {
  configure("local-demo");
  await startSession(personas[1].id, secondWorkspaceId);
  expect(boundary.revokeSession).toHaveBeenCalledExactlyOnceWith(existingToken);
  expect(boundary.values.has("loom_session")).toBe(false);
  const payload = `v2.${personas[1].id}.${secondWorkspaceId}.${Date.now()}`;
  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  expect(boundary.set).toHaveBeenCalledWith(
    "loom_demo_session",
    `${payload}.${signature}`,
    {
      httpOnly: true,
      sameSite: "strict",
      secure: false,
      path: "/",
      maxAge: 8 * 60 * 60,
    },
  );
  expect(await actorFromCookie()).toEqual({
    userId: personas[1].id,
    workspaceId: secondWorkspaceId,
  });
  expect(boundary.sessionActor).not.toHaveBeenCalled();
});

it("rejects a forged selected workspace even when the original demo signature is valid", async () => {
  configure("local-demo");
  await startSession(personas[0].id, workspaceId);
  const signed = boundary.values.get("loom_demo_session")!;
  boundary.values.set(
    "loom_demo_session",
    signed.replace(workspaceId, secondWorkspaceId),
  );
  expect(await actorFromCookie()).toBeNull();
});
