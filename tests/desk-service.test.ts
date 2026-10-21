import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { personas, workspaceId, type Actor } from "@loom/contracts";
import { sampleRequests } from "../packages/contracts/src/fixtures";
const db = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn() }));
vi.mock("@loom/db-exasol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@loom/db-exasol")>();
  return {
    ...actual,
    isConfigured: () => true,
    readDatabase: async (work: (sql: typeof db) => unknown) => work(db),
    writeDatabase: async (work: (sql: typeof db) => unknown) => work(db),
  };
});
import {
  analytics,
  createRequest,
  details,
  mutateRequest,
  snapshot,
} from "../apps/web/server/desk";
let role = "operator";
let actor: Actor;
let receipt: Record<string, unknown> | null = null;
const r = sampleRequests[0];
const row = {
  WORKSPACE_ID: r.workspaceId,
  ID: r.id,
  REQUESTER_ID: r.requesterId,
  REQUESTER_NAME: r.requesterName,
  TITLE: r.title,
  BUSINESS_QUESTION: r.businessQuestion,
  REPORTING_PERIOD: r.reportingPeriod,
  DATASET: r.dataset,
  OWNER_ID: r.ownerId,
  OWNER_NAME: r.ownerName,
  PRIORITY: r.priority,
  STATUS: r.status,
  DUE_AT: r.dueAt,
  VERSION: r.version,
  CREATED_AT: r.createdAt,
  UPDATED_AT: r.updatedAt,
};
beforeEach(() => {
  role = "operator";
  actor = { workspaceId, userId: personas[1].id };
  receipt = null;
  db.query.mockReset();
  db.execute.mockReset().mockResolvedValue(1);
  db.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM MEMBERSHIPS") && sql.includes("USER_ID = ?"))
      return [{ USER_ID: actor.userId, NAME: "Test member", ROLE: role }];
    if (sql.includes("FROM MEMBERSHIPS"))
      return personas.map((p) => ({
        USER_ID: p.id,
        NAME: p.name,
        ROLE: p.role,
      }));
    if (sql.includes("FROM REQUESTS R")) return [row];
    if (sql.includes("FROM COMMAND_RECEIPTS")) return receipt ? [receipt] : [];
    return [];
  });
});
describe("scoped request service with a scripted SQL boundary (not a live database)", () => {
  it("binds requester scope in SQL and removes internal priority", async () => {
    role = "requester";
    actor.userId = personas[2].id;
    const desk = await snapshot(actor);
    const call = db.query.mock.calls.find(([sql]) =>
      sql.includes("FROM REQUESTS R"),
    )!;
    expect(call[0]).toContain("R.WORKSPACE_ID = ? AND R.REQUESTER_ID = ?");
    expect(call[1]).toEqual([workspaceId, actor.userId]);
    expect(desk.requests[0]).not.toHaveProperty("priority");
    expect(desk.members).toEqual([]);
  });
  it("applies requester filtering to comments before reading them", async () => {
    role = "requester";
    actor.userId = personas[2].id;
    await details(actor, r.id);
    const call = db.query.mock.calls.find(([sql]) =>
      sql.includes("FROM COMMENTS"),
    )!;
    expect(call[0]).toContain("C.VISIBILITY = 'requester_visible'");
    expect(call[1]).toEqual([workspaceId, r.id]);
  });
  it("blocks viewer writes and requester aggregate reads before SQL effects", async () => {
    role = "viewer";
    await expect(createRequest(actor, crypto.randomUUID(), r)).rejects.toThrow(
      "Viewers cannot",
    );
    expect(db.execute).not.toHaveBeenCalled();
    role = "requester";
    await expect(analytics(actor)).rejects.toThrow("restricted");
    expect(
      db.query.mock.calls.some(([sql]) => sql.includes("OPEN_COUNT")),
    ).toBe(false);
  });
  it("rejects a stale edit without writing a receipt or partial history", async () => {
    await expect(
      mutateRequest(actor, r.id, crypto.randomUUID(), 99, {
        type: "set_status",
        status: "done",
      }),
    ).rejects.toThrow("changed");
    expect(db.execute).not.toHaveBeenCalled();
  });
  it("reconciles an acknowledged command by receipt before checking stale versions", async () => {
    const command = { type: "set_status", status: "done" } as const;
    receipt = {
      ACTOR_ID: actor.userId,
      PAYLOAD_HASH: createHash("sha256")
        .update(JSON.stringify({ id: r.id, expectedVersion: 1, command }))
        .digest("hex"),
      RESULT_JSON: JSON.stringify({ ...r, version: 2, status: "done" }),
    };
    expect(
      (await mutateRequest(actor, r.id, crypto.randomUUID(), 1, command))
        .version,
    ).toBe(2);
    expect(db.execute).not.toHaveBeenCalled();
  });
  it("rejects reusing a command ID with changed content", async () => {
    receipt = {
      ACTOR_ID: actor.userId,
      PAYLOAD_HASH: "different",
      RESULT_JSON: "{}",
    };
    await expect(
      mutateRequest(actor, r.id, crypto.randomUUID(), 1, {
        type: "set_status",
        status: "done",
      }),
    ).rejects.toThrow("different action");
    expect(db.execute).not.toHaveBeenCalled();
  });
  it("writes versioned state, history, audit, outbox, and receipt through one session", async () => {
    const result = await mutateRequest(actor, r.id, crypto.randomUUID(), 1, {
      type: "set_status",
      status: "done",
    });
    expect(result.version).toBe(2);
    expect(
      db.execute.mock.calls.map(([sql]) =>
        sql.split(" ").slice(0, 3).join(" "),
      ),
    ).toEqual([
      "UPDATE REQUESTS SET",
      "INSERT INTO REQUEST_EVENTS",
      "INSERT INTO AUDIT_EVENTS",
      "INSERT INTO OUTBOX_EVENTS",
      "INSERT INTO COMMAND_RECEIPTS",
    ]);
    expect(db.execute.mock.calls[0][1].slice(-3)).toEqual([
      workspaceId,
      r.id,
      1,
    ]);
  });
  it("fails closed if the version update affects no rows", async () => {
    db.execute.mockResolvedValueOnce(0);
    await expect(
      mutateRequest(actor, r.id, crypto.randomUUID(), 1, {
        type: "set_status",
        status: "done",
      }),
    ).rejects.toThrow("changed");
    expect(db.execute).toHaveBeenCalledTimes(1);
  });
});
