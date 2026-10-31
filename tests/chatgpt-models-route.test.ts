import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { DomainError } from "@loom/domain";
const boundary = vi.hoisted(() => ({
  credential: vi.fn(),
  current: vi.fn(),
  catalog: vi.fn(),
  actor: { workspaceId: "", userId: "" },
}));
vi.mock("../apps/web/server/http", async (original) => ({
  ...(await original<typeof import("../apps/web/server/http")>()),
  requireActor: async () => boundary.actor,
}));
vi.mock("../apps/web/server/openai-oauth-store", () => ({
  getOpenAiPlanCredential: boundary.credential,
  assertOpenAiPlanCurrent: boundary.current,
}));
vi.mock("../apps/web/server/model-catalog", () => ({
  fetchModelCatalog: boundary.catalog,
}));
vi.mock("@loom/db-exasol", async (original) => ({
  ...(await original<typeof import("@loom/db-exasol")>()),
  readDatabase: async (fn: (sql: object) => Promise<unknown>) => fn({}),
}));
import { GET } from "../apps/web/app/api/workspaces/codex/models/route";
const origin = "http://127.0.0.1:3000";
beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", origin);
  vi.stubEnv("LOOM_OPENAI_LOCAL_ENABLED", "true");
  vi.stubEnv("LOOM_PROVIDER_ENCRYPTION_KEY", "a".repeat(64));
  boundary.actor = { workspaceId: randomUUID(), userId: randomUUID() };
  boundary.credential.mockReset().mockResolvedValue({
    clientId: "client",
    subject: "subject",
    revision: 1,
    accessToken: "synthetic-private-token",
  });
  boundary.current.mockReset().mockResolvedValue(undefined);
  boundary.catalog
    .mockReset()
    .mockResolvedValue([{ id: "plan-model", name: "Plan model" }]);
});
afterEach(() => vi.unstubAllEnvs());
function request(
  workspace = boundary.actor.workspaceId,
  host = "127.0.0.1:3000",
) {
  return new Request(`${origin}/api/workspaces/codex/models`, {
    headers: { host, "X-Loom-Workspace": workspace },
  });
}
it("returns only model choices using the current owner's token and rechecks account identity", async () => {
  const response = await GET(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    models: [{ id: "plan-model", name: "Plan model" }],
  });
  expect(boundary.catalog).toHaveBeenCalledWith(
    "openai",
    "synthetic-private-token",
    true,
  );
  expect(boundary.current).toHaveBeenCalledWith(
    {},
    boundary.actor,
    expect.objectContaining({ clientId: "client", revision: 1 }),
  );
  expect(response.headers.get("cache-control")).toContain("no-store");
});
it("rejects another workspace or noncanonical host before reading tokens", async () => {
  expect((await GET(request(randomUUID()))).status).toBe(409);
  expect(
    (await GET(request(boundary.actor.workspaceId, "foreign.example"))).status,
  ).toBe(409);
  expect(boundary.credential).not.toHaveBeenCalled();
  expect(boundary.catalog).not.toHaveBeenCalled();
});
it("does not load a catalogue without the owner's authorized plan", async () => {
  boundary.credential.mockResolvedValue(null);
  expect((await GET(request())).status).toBe(403);
  expect(boundary.catalog).not.toHaveBeenCalled();
});
it("discards a model list if account access changes while loading", async () => {
  boundary.current.mockRejectedValue(
    new DomainError("OPENAI_CONNECTION_CHANGED", "Connection changed.", 409),
  );
  const response = await GET(request());
  expect(response.status).toBe(409);
  expect(await response.text()).not.toContain("plan-model");
});
