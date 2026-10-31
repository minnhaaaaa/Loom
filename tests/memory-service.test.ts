import { beforeEach, expect, it, vi } from "vitest";
import { readTeamMemory } from "../apps/web/server/memory";
import { DomainError } from "@loom/domain";

const boundary = vi.hoisted(() => ({ query: vi.fn(), authorize: vi.fn() }));
vi.mock("@loom/db-exasol", () => ({
  fromTimestamp: (value: unknown) => String(value),
  readDatabase: (work: (sql: unknown) => unknown) => work(boundary),
}));
vi.mock("../apps/web/server/knowledge", () => ({
  requireOperator: boundary.authorize,
}));
vi.mock("../apps/web/server/desk", async () => {
  const { createHash } = await import("node:crypto");
  return {
    digest: (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    requestSelect: "SELECT R.* FROM REQUESTS R",
    mapRequest: (row: unknown) => row,
    membersFor: async () => [],
  };
});
const actor = { workspaceId: "fixture-workspace", userId: "fixture-owner" };
beforeEach(() => {
  boundary.query.mockReset().mockResolvedValue([]);
  boundary.authorize.mockReset().mockResolvedValue({ role: "owner" });
});

it("denies retrieval before loading any workspace content", async () => {
  boundary.authorize.mockRejectedValue(
    new DomainError("ACCESS_DENIED", "Owner or operator required.", 403),
  );
  await expect(readTeamMemory(actor)).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  expect(boundary.query).not.toHaveBeenCalled();
});

it("scopes every source, proposal, record and event query to the authorized workspace", async () => {
  const memory = await readTeamMemory(actor, {
    q: "revenue",
    kind: "routing",
    dataset: "Ledger",
  });
  expect(memory.entries).toEqual([]);
  expect(memory.graph).toEqual({ nodes: [], edges: [] });
  expect(memory.timeline).toEqual([]);
  for (const [sql, values] of boundary.query.mock.calls) {
    expect(sql).toMatch(/WORKSPACE_ID = \?/);
    expect(values[0]).toBe(actor.workspaceId);
    expect(sql).not.toContain("revenue");
    expect(sql).not.toContain("Ledger");
  }
  expect(boundary.query.mock.calls[0][1]).toEqual([
    actor.workspaceId,
    "routing",
    "Ledger",
    "revenue",
    "revenue",
    "revenue",
  ]);
});

it("refuses corrupted persisted knowledge instead of displaying it as evidence", async () => {
  boundary.query.mockResolvedValueOnce([
    {
      ID: "source",
      CONTENT_JSON: JSON.stringify({
        title: "Procedure",
        kind: "procedure",
        content: "Use Ledger.",
        dataset: "Ledger",
        ownerId: null,
        effectiveFrom: "2026-01-01",
        effectiveUntil: null,
        supersedesId: null,
      }),
      CONTENT_HASH: "tampered",
    },
  ]);
  await expect(readTeamMemory(actor)).rejects.toMatchObject({
    code: "KNOWLEDGE_INTEGRITY",
  });
});
