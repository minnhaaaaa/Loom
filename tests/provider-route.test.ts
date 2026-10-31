import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Actor } from "@loom/contracts";
const boundary = vi.hoisted(() => ({
  actor: null as Actor | null,
  read: vi.fn(),
  save: vi.fn(),
  models: vi.fn(),
}));
vi.mock("../apps/web/server/http", async (original) => {
  const actual = await original<typeof import("../apps/web/server/http")>();
  return { ...actual, requireActor: async () => boundary.actor };
});
vi.mock("../apps/web/server/provider-config", () => ({
  readProviderSettings: boundary.read,
  updateProviderSettings: boundary.save,
  listCompanyModels: boundary.models,
}));
import { GET, POST } from "../apps/web/app/api/workspaces/provider/route";
import { POST as MODELS } from "../apps/web/app/api/workspaces/provider/models/route";
const origin = "http://127.0.0.1:3000";
beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", origin);
  boundary.actor = { workspaceId: randomUUID(), userId: randomUUID() };
  boundary.read.mockReset().mockResolvedValue({ active: false });
  boundary.save.mockReset().mockResolvedValue({ active: false });
  boundary.models.mockReset().mockResolvedValue({ models: [] });
});
afterEach(() => vi.unstubAllEnvs());
function request(
  workspace: string,
  method: "GET" | "POST",
  requestOrigin = origin,
) {
  return new Request(`${origin}/api/workspaces/provider`, {
    method,
    headers: {
      "X-Loom-Workspace": workspace,
      origin: requestOrigin,
      "Content-Type": "application/json",
    },
    ...(method === "POST"
      ? {
          body: JSON.stringify({
            action: "revoke",
            commandId: randomUUID(),
            expectedVersion: 1,
          }),
        }
      : {}),
  });
}
it("rejects stale-company forms before reading or changing provider settings", async () => {
  const staleCompany = randomUUID();
  expect((await GET(request(staleCompany, "GET"))).status).toBe(409);
  expect((await POST(request(staleCompany, "POST"))).status).toBe(409);
  expect(boundary.read).not.toHaveBeenCalled();
  expect(boundary.save).not.toHaveBeenCalled();
});
it("passes only the authenticated company actor to the provider service", async () => {
  const actor = boundary.actor!;
  expect((await GET(request(actor.workspaceId, "GET"))).status).toBe(200);
  expect((await POST(request(actor.workspaceId, "POST"))).status).toBe(200);
  expect(boundary.read).toHaveBeenCalledWith(actor);
  expect(boundary.save).toHaveBeenCalledWith(
    actor,
    expect.objectContaining({ action: "revoke" }),
  );
});
it("rejects foreign-origin provider writes before invoking the service", async () => {
  expect(
    (
      await POST(
        request(boundary.actor!.workspaceId, "POST", "https://foreign.example"),
      )
    ).status,
  ).toBe(403);
  expect(boundary.save).not.toHaveBeenCalled();
});
it("scopes model discovery and rejects foreign origins or unsupported providers before using credentials", async () => {
  function modelsRequest(
    workspace = boundary.actor!.workspaceId,
    provider = "openai",
    requestOrigin = origin,
  ) {
    return new Request(`${origin}/api/workspaces/provider/models`, {
      method: "POST",
      headers: {
        origin: requestOrigin,
        "Content-Type": "application/json",
        "X-Loom-Workspace": workspace,
      },
      body: JSON.stringify({ provider, apiKey: "synthetic-catalog-key" }),
    });
  }
  expect((await MODELS(modelsRequest(randomUUID()))).status).toBe(409);
  expect(
    (
      await MODELS(
        modelsRequest(
          boundary.actor!.workspaceId,
          "openai",
          "https://foreign.example",
        ),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await MODELS(
        modelsRequest(boundary.actor!.workspaceId, "https://foreign.example"),
      )
    ).status,
  ).toBe(422);
  expect(boundary.models).not.toHaveBeenCalled();
  expect((await MODELS(modelsRequest())).status).toBe(200);
  expect(boundary.models).toHaveBeenCalledWith(boundary.actor, {
    provider: "openai",
    apiKey: "synthetic-catalog-key",
  });
});
