import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
const boundary = vi.hoisted(() => ({
  member: vi.fn(),
  query: vi.fn(),
  write: vi.fn(),
  catalog: vi.fn(),
}));
vi.mock("@loom/db-exasol", async (original) => ({
  ...(await original<typeof import("@loom/db-exasol")>()),
  readDatabase: async (fn: (sql: object) => Promise<unknown>) =>
    fn({ query: boundary.query }),
  writeDatabase: boundary.write,
}));
vi.mock("../apps/web/server/desk", async (original) => ({
  ...(await original<typeof import("../apps/web/server/desk")>()),
  membership: boundary.member,
}));
vi.mock("../apps/web/server/model-catalog", () => ({
  fetchModelCatalog: boundary.catalog,
}));
import {
  listCompanyModels,
  encryptProviderCredential,
} from "../apps/web/server/provider-config";
const actor = { workspaceId: randomUUID(), userId: randomUUID() };
beforeEach(() => {
  vi.stubEnv("LOOM_PROVIDER_ENCRYPTION_KEY", "b".repeat(64));
  boundary.member.mockReset().mockResolvedValue({ role: "owner" });
  boundary.query.mockReset().mockResolvedValue([]);
  boundary.write.mockReset();
  boundary.catalog
    .mockReset()
    .mockResolvedValue([{ id: "model-a", name: "A" }]);
});
afterEach(() => vi.unstubAllEnvs());
it("rejects nonowners before querying credentials or calling a provider", async () => {
  boundary.member.mockResolvedValue({ role: "operator" });
  await expect(
    listCompanyModels(actor, { provider: "openai", apiKey: "synthetic-key" }),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  expect(boundary.catalog).not.toHaveBeenCalled();
  expect(boundary.query).not.toHaveBeenCalled();
});
it("uses a supplied key only for model discovery and never persists it", async () => {
  expect(
    await listCompanyModels(actor, {
      provider: "kimi",
      apiKey: "synthetic-key",
    }),
  ).toEqual({ models: [{ id: "model-a", name: "A" }] });
  expect(boundary.catalog).toHaveBeenCalledWith("kimi", "synthetic-key");
  expect(boundary.write).not.toHaveBeenCalled();
  expect(boundary.member).toHaveBeenCalledTimes(2);
});
it("unlocks only the selected company's matching saved provider and rejects a changed connection", async () => {
  const row = {
    ACTIVE: true,
    PROVIDER: "openai",
    VERSION: 2,
    MODEL: "model-a",
    CREDENTIAL: encryptProviderCredential(
      "saved-synthetic-key",
      JSON.stringify({
        workspaceId: actor.workspaceId,
        version: 2,
        provider: "openai",
        model: "model-a",
      }),
    ),
  };
  boundary.query.mockResolvedValue([row]);
  await expect(
    listCompanyModels(actor, { provider: "deepseek" }),
  ).rejects.toMatchObject({ code: "PROVIDER_KEY_REQUIRED" });
  expect(boundary.catalog).not.toHaveBeenCalled();
  boundary.query
    .mockResolvedValueOnce([row])
    .mockResolvedValueOnce([{ ...row, VERSION: 3 }]);
  await expect(
    listCompanyModels(actor, { provider: "openai" }),
  ).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });
  expect(boundary.catalog).toHaveBeenCalledWith(
    "openai",
    "saved-synthetic-key",
  );
  expect(boundary.write).not.toHaveBeenCalled();
});
