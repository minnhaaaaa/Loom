import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  defaultWorkspaceSettings,
  personas,
  workspaceId,
} from "@loom/contracts";

const boundary = vi.hoisted(() => ({
  signedIn: true,
  cookies: vi.fn(),
  sessionActor: vi.fn(),
  readSettings: vi.fn(),
  saveSettings: vi.fn(),
  createAgent: vi.fn(),
  listAgents: vi.fn(),
  revokeAgent: vi.fn(),
}));
vi.mock("../apps/web/node_modules/next/headers.js", () => ({
  cookies: boundary.cookies,
}));
vi.mock("../apps/web/server/accounts", () => ({
  accountContext: vi.fn(),
  sessionActor: boundary.sessionActor,
  revokeSession: vi.fn(),
  selectSessionWorkspace: vi.fn(),
}));
vi.mock("../apps/web/server/settings", () => ({
  readWorkspaceSettings: boundary.readSettings,
  updateWorkspaceSettings: boundary.saveSettings,
  createAgentConnection: boundary.createAgent,
  listAgentConnections: boundary.listAgents,
  revokeAgentConnection: boundary.revokeAgent,
}));
import {
  GET as getSettings,
  POST as saveSettings,
} from "../apps/web/app/api/workspaces/settings/route";
import {
  GET as getAgents,
  POST as createAgent,
} from "../apps/web/app/api/workspaces/agents/route";
import { POST as revokeAgent } from "../apps/web/app/api/workspaces/agents/[id]/revoke/route";

const origin = "http://127.0.0.1:3000",
  actor = { workspaceId, userId: personas[0].id };
const settings = {
  commandId: randomUUID(),
  expectedVersion: 0,
  branding: { ...defaultWorkspaceSettings.branding, companyName: "Acme" },
  preferredAgent: "codex",
  completeSetup: true,
};
beforeEach(() => {
  vi.stubEnv("LOOM_AUTH_MODE", "workspace");
  vi.stubEnv("APP_ORIGIN", origin);
  vi.stubEnv(
    "LOOM_SESSION_SECRET",
    "public-route-test-key-at-least-thirty-two-characters",
  );
  boundary.signedIn = true;
  boundary.cookies.mockReset().mockImplementation(async () => ({
    get: (name: string) =>
      boundary.signedIn && name === "loom_session"
        ? { name, value: "test-only-session" }
        : undefined,
  }));
  boundary.sessionActor.mockReset().mockResolvedValue(actor);
  boundary.readSettings.mockReset().mockResolvedValue(defaultWorkspaceSettings);
  boundary.saveSettings
    .mockReset()
    .mockResolvedValue({ ...defaultWorkspaceSettings, version: 1 });
  boundary.listAgents.mockReset().mockResolvedValue({ connections: [] });
  boundary.createAgent.mockReset().mockResolvedValue({
    connection: { id: randomUUID() },
    token: "test-only-raw-token",
  });
  boundary.revokeAgent.mockReset().mockResolvedValue({
    id: randomUUID(),
    revokedAt: new Date().toISOString(),
  });
});
afterEach(() => vi.unstubAllEnvs());
function request(
  body: object,
  headers: Record<string, string> = {},
  method = "POST",
) {
  return new Request(`${origin}/api/workspaces/settings`, {
    method,
    headers: { origin, "content-type": "application/json", ...headers },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}

it("protects all company and agent writes with origin/content checks before session access", async () => {
  const invalidHeaders: Record<string, string>[] = [
    { origin: "https://attacker.example" },
    { origin: "" },
    { "content-type": "text/plain" },
  ];
  for (const headers of invalidHeaders) {
    expect([403, 415]).toContain(
      (await saveSettings(request(settings, headers))).status,
    );
    expect([403, 415]).toContain(
      (
        await createAgent(
          request(
            { commandId: randomUUID(), client: "codex", label: "Codex" },
            headers,
          ),
        )
      ).status,
    );
    expect([403, 415]).toContain(
      (
        await revokeAgent(
          request({ commandId: randomUUID(), expectedVersion: 1 }, headers),
          { params: Promise.resolve({ id: randomUUID() }) },
        )
      ).status,
    );
  }
  expect(boundary.cookies).not.toHaveBeenCalled();
  expect(boundary.saveSettings).not.toHaveBeenCalled();
  expect(boundary.createAgent).not.toHaveBeenCalled();
});

it("uses the cookie actor, rejects forged scope/unsafe values and makes secret responses private", async () => {
  boundary.signedIn = false;
  expect((await getSettings(request({}, {}, "GET"))).status).toBe(401);
  expect((await getAgents(request({}, {}, "GET"))).status).toBe(401);
  boundary.signedIn = true;
  for (const body of [
    { ...settings, workspaceId: randomUUID() },
    {
      ...settings,
      branding: { ...settings.branding, primaryColor: "url(attacker)" },
    },
  ])
    expect((await saveSettings(request(body))).status).toBe(422);
  const saved = await saveSettings(request(settings));
  expect(saved.status).toBe(200);
  expect(boundary.saveSettings).toHaveBeenCalledWith(actor, settings);
  const values = {
    commandId: randomUUID(),
    client: "codex",
    label: "Team agent",
  };
  const created = await createAgent(request(values));
  expect(created.status).toBe(200);
  expect(boundary.createAgent).toHaveBeenCalledWith(actor, values);
  expect(created.headers.get("cache-control")).toContain("no-store");
  expect(created.headers.get("vary")).toContain("Cookie");
  expect((await created.json()).token).toBe("test-only-raw-token");
  const id = randomUUID(),
    revoke = { commandId: randomUUID(), expectedVersion: 1 };
  expect(
    (await revokeAgent(request(revoke), { params: Promise.resolve({ id }) }))
      .status,
  ).toBe(200);
  expect(boundary.revokeAgent).toHaveBeenCalledWith(
    actor,
    id,
    revoke.commandId,
    1,
  );
});
