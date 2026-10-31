import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Actor } from "@loom/contracts";
import { endpoint, requireActor } from "../apps/web/server/http";
import { workspaceFetch } from "../apps/web/components/workspace-fetch";

const boundary = vi.hoisted(() => ({ sessionActor: vi.fn() }));
vi.mock("../apps/web/node_modules/next/headers.js", () => ({
  cookies: async () => ({ get: () => ({ value: "test-session" }) }),
}));
vi.mock("../apps/web/server/accounts", () => ({
  accountContext: vi.fn(),
  sessionActor: boundary.sessionActor,
  revokeSession: vi.fn(),
  selectSessionWorkspace: vi.fn(),
}));
const origin = "http://127.0.0.1:3000";
let actor: Actor;
beforeEach(() => {
  vi.stubEnv("LOOM_AUTH_MODE", "workspace");
  vi.stubEnv("APP_ORIGIN", origin);
  vi.stubEnv(
    "LOOM_SESSION_SECRET",
    "public-test-session-secret-longer-than-32",
  );
  actor = { userId: randomUUID(), workspaceId: randomUUID() };
  boundary.sessionActor.mockReset().mockResolvedValue(actor);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
function request(path: string, workspace?: string) {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: {
      origin,
      "Content-Type": "application/json",
      ...(workspace ? { "X-Loom-Workspace": workspace } : {}),
    },
    body: "{}",
  });
}

it("rejects a stale rendered company before an authenticated mutation runs", async () => {
  const save = vi.fn();
  const handler = endpoint(async () => {
    const current = await requireActor();
    save(current);
    return { ok: true };
  }, true);
  const response = await handler(request("/api/requests", randomUUID()));
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: { code: "WORKSPACE_CHANGED" },
  });
  expect(save).not.toHaveBeenCalled();
});

it("allows matching scope and legacy requests while still requiring authentication", async () => {
  const handler = endpoint(async () => requireActor(), true);
  for (const workspace of [actor.workspaceId, undefined]) {
    const response = await handler(request("/api/requests", workspace));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(actor);
  }
  boundary.sessionActor.mockResolvedValue(null);
  expect(
    (await handler(request("/api/requests", actor.workspaceId))).status,
  ).toBe(401);
});

it("leaves explicit selection and account discovery independent of the old rendered company", async () => {
  const handler = endpoint(async () => requireActor(), true);
  for (const path of ["/api/workspaces/select", "/api/account"]) {
    const response = await handler(request(path, randomUUID()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(actor);
  }
});

it("keeps concurrent request scopes isolated and checks each session resolution", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler = endpoint(async () => {
    await gate;
    return requireActor();
  }, true);
  const matching = handler(request("/api/requests", actor.workspaceId));
  const stale = handler(request("/api/requests", randomUUID()));
  release();
  expect((await matching).status).toBe(200);
  expect((await stale).status).toBe(409);
  // Request-local state must not escape into server rendering or another call.
  expect(await requireActor()).toEqual(actor);

  const changing = endpoint(async () => {
    await requireActor();
    return requireActor();
  }, true);
  boundary.sessionActor
    .mockResolvedValueOnce(actor)
    .mockResolvedValueOnce({ ...actor, workspaceId: randomUUID() });
  expect(
    (await changing(request("/api/requests", actor.workspaceId))).status,
  ).toBe(409);
});

function browser() {
  const fetch = vi.fn().mockResolvedValue(new Response("{}"));
  const getAttribute = vi.fn().mockReturnValue(actor.workspaceId);
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("document", {
    querySelector: vi.fn().mockReturnValue({ getAttribute }),
  });
  return { fetch, getAttribute };
}
it("sends the visible company with API requests and preserves an explicitly captured scope", async () => {
  const { fetch } = browser();
  await workspaceFetch("/api/knowledge", {
    method: "POST",
    body: "{}",
    headers: { "Content-Type": "application/json" },
  });
  const first = fetch.mock.calls[0][1] as RequestInit;
  expect(new Headers(first.headers).get("X-Loom-Workspace")).toBe(
    actor.workspaceId,
  );
  expect(new Headers(first.headers).get("Content-Type")).toBe(
    "application/json",
  );
  const captured = randomUUID();
  await workspaceFetch("/api/workspaces/provider", {
    headers: new Headers({ "X-Loom-Workspace": captured }),
  });
  expect(
    new Headers(fetch.mock.calls[1][1].headers).get("X-Loom-Workspace"),
  ).toBe(captured);
});

it("never sends stale company scope with account polling, selection, or login", async () => {
  const { fetch } = browser();
  for (const path of [
    "/api/account?refresh=1",
    "/api/workspaces/select",
    "/api/account/login",
    "/api/invitations/accept",
  ]) {
    await workspaceFetch(path, {
      headers: { "X-Loom-Workspace": actor.workspaceId },
    });
  }
  for (const call of fetch.mock.calls)
    expect(new Headers(call[1].headers).has("X-Loom-Workspace")).toBe(false);
});

it("does not attach company scope outside the workspace API or without a rendered workspace", async () => {
  const { fetch, getAttribute } = browser();
  await workspaceFetch("https://external.example/api/example");
  getAttribute.mockReturnValue(null);
  await workspaceFetch("/api/desk");
  for (const call of fetch.mock.calls)
    expect(new Headers(call[1].headers).has("X-Loom-Workspace")).toBe(false);
});
