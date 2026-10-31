import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  isConfigured,
  readDatabase,
  sqlTimestamp,
  writeDatabase,
} from "@loom/db-exasol";
import type { Actor, Status } from "@loom/contracts";
import { readInsights } from "../../apps/web/server/insights";
import {
  conversationContext,
  mapConversationTurn,
} from "../../apps/web/server/conversation-store";
import { digest } from "../../apps/web/server/desk";

if (!isConfigured())
  throw new Error("Real Exasol is required for analytics integration tests.");
const workspace = randomUUID(),
  otherWorkspace = randomUUID();
const owner: Actor = { workspaceId: workspace, userId: randomUUID() };
const operator: Actor = { workspaceId: workspace, userId: randomUUID() };
const requester: Actor = { workspaceId: workspace, userId: randomUUID() };
const viewer: Actor = { workspaceId: workspace, userId: randomUUID() };
const other: Actor = { workspaceId: otherWorkspace, userId: randomUUID() };
const at = new Date("2026-11-01T00:00:00.000Z");
const ids: Record<string, string> = {};
const iso = (day: string) => `${day}T00:00:00.000Z`;
type Event = readonly [string, Status];

beforeAll(async () => {
  await writeDatabase(async (sql) => {
    for (const id of [workspace, otherWorkspace])
      await sql.execute("INSERT INTO WORKSPACES (ID,NAME) VALUES (?,?)", [
        id,
        "Isolated analytics fixture",
      ]);
    for (const [actor, role, name] of [
      [owner, "owner", "Lead"],
      [operator, "operator", "Analyst"],
      [requester, "requester", "Requester"],
      [viewer, "viewer", "Viewer"],
      [other, "owner", "Other lead"],
    ] as const)
      await sql.execute(
        "INSERT INTO MEMBERSHIPS (WORKSPACE_ID,USER_ID,NAME,ROLE,ACTIVE) VALUES (?,?,?,?,TRUE)",
        [actor.workspaceId, actor.userId, name, role],
      );
    async function record(
      name: string,
      events: readonly Event[],
      assigned: string | null = owner.userId,
      due: string | null = null,
      actor = owner,
    ) {
      const id = (ids[name] = randomUUID());
      const final = events.at(-1)!;
      await sql.execute(
        "INSERT INTO REQUESTS (WORKSPACE_ID,ID,REQUESTER_ID,TITLE,BUSINESS_QUESTION,REPORTING_PERIOD,DATASET,OWNER_ID,PRIORITY,STATUS,DUE_AT,VERSION,CREATED_AT,UPDATED_AT) VALUES (?,?,?,?,?,?,?,?,?,?,CAST(? AS DATE),?,?,?)",
        [
          actor.workspaceId,
          id,
          actor.userId,
          name,
          "Synthetic analytics fixture",
          "October",
          "Synthetic",
          assigned,
          "normal",
          final[1],
          due,
          events.length,
          sqlTimestamp(iso(events[0][0])),
          sqlTimestamp(iso(final[0])),
        ],
      );
      for (const [index, [day, status]] of events.entries())
        await sql.execute(
          "INSERT INTO REQUEST_EVENTS (WORKSPACE_ID,ID,REQUEST_ID,ACTOR_ID,ACTION_KIND,VERSION,STATUS,SNAPSHOT_JSON,CREATED_AT) VALUES (?,?,?,?,?,?,?,?,?)",
          [
            actor.workspaceId,
            randomUUID(),
            id,
            actor.userId,
            index === 0 ? "created" : "fixture",
            index + 1,
            status,
            "{}",
            sqlTimestamp(iso(day)),
          ],
        );
    }
    await record("Reopened request", [
      ["2026-09-20", "needs_info"],
      ["2026-10-04", "ready"],
      ["2026-10-06", "in_progress"],
      ["2026-10-08", "done"],
      ["2026-10-20", "ready"],
      ["2026-10-21", "in_progress"],
      ["2026-10-22", "done"],
    ]);
    await record(
      "Still awaiting information",
      [
        ["2026-10-03", "new"],
        ["2026-10-04", "needs_info"],
        ["2026-10-05", "needs_info"],
      ],
      operator.userId,
      "2026-10-31",
    );
    await record("Cancelled request", [
      ["2026-10-10", "ready"],
      ["2026-10-12", "cancelled"],
    ]);
    await record("Closed before window", [
      ["2026-09-01", "in_progress"],
      ["2026-09-05", "done"],
    ]);
    await record(
      "Unassigned new request",
      [["2026-10-30", "new"]],
      null,
      "2026-11-01",
    );
    await record("Carryover completed", [
      ["2026-10-01", "ready"],
      ["2026-10-03", "done"],
    ]);
    await record("At window boundary", [
      ["2026-10-02", "needs_info"],
      ["2026-10-03", "done"],
    ]);
    await record("Same-time transitions", [
      ["2026-10-31", "new"],
      ["2026-10-31", "ready"],
    ]);
    await record("At cutoff boundary", [["2026-11-01", "new"]]);
    await record(
      "Other workspace secret",
      [["2026-10-02", "needs_info"]],
      other.userId,
      null,
      other,
    );
  });
});

afterAll(async () => {
  await writeDatabase(async (sql) => {
    for (const table of [
      "REQUEST_EVENTS",
      "REQUESTS",
      "MEMBERSHIPS",
      "WORKSPACES",
    ])
      for (const id of [workspace, otherWorkspace])
        await sql.execute(
          `DELETE FROM ${table} WHERE ${table === "WORKSPACES" ? "ID" : "WORKSPACE_ID"}=?`,
          [id],
        );
  });
});

it("computes clipped status intervals, repeats, open tails and percentiles in real Exasol", async () => {
  const result = await readInsights(owner, { days: 30 }, at);
  expect(result.from).toBe("2026-10-02T00:00:00.000Z");
  const phase = (status: string) =>
    result.phases.find((item) => item.status === status)!;
  expect(phase("new")).toMatchObject({
    requestCount: 2,
    totalHours: 72,
    medianHours: 36,
  });
  expect(phase("new").p90Hours).toBeCloseTo(45.6);
  expect(phase("needs_info")).toMatchObject({
    requestCount: 3,
    totalHours: 744,
    medianHours: 48,
  });
  expect(phase("needs_info").p90Hours).toBeCloseTo(547.2);
  expect(phase("ready")).toMatchObject({
    requestCount: 4,
    totalHours: 168,
    medianHours: 36,
  });
  expect(phase("ready").p90Hours).toBeCloseTo(64.8);
  expect(phase("in_progress")).toMatchObject({
    requestCount: 1,
    totalHours: 72,
    medianHours: 72,
    p90Hours: 72,
  });
  expect(result.records).toHaveLength(7);
  expect(
    result.records.find((row) => row.id === ids["Reopened request"]),
  ).toMatchObject({
    needsInfoHours: 48,
    readyHours: 72,
    inProgressHours: 72,
    firstEventVersion: 1,
    lastEventVersion: 6,
  });
  expect(
    result.records.some(
      (row) =>
        row.title.includes("Other workspace") ||
        row.title === "At cutoff boundary" ||
        row.title === "Closed before window",
    ),
  ).toBe(false);
  expect(result.evidence).toHaveLength(4);
  expect(result.evidence.every((item) => item.sqlHash.length === 64)).toBe(
    true,
  );
});

it("balances weekly backlog with carryover, repeated completion and reopening", async () => {
  const result = await readInsights(operator, { days: 30 }, at);
  expect(
    result.flow.map((row) => [
      row.weekStart,
      row.incoming,
      row.completions,
      row.cancellations,
      row.reopens,
      row.endingBacklog,
    ]),
  ).toEqual([
    ["2026-09-28", 2, 2, 0, 0, 2],
    ["2026-10-05", 1, 1, 0, 0, 2],
    ["2026-10-12", 0, 0, 1, 0, 1],
    ["2026-10-19", 0, 1, 0, 1, 1],
    ["2026-10-26", 2, 0, 0, 0, 3],
  ]);
  expect(
    result.owners.find((row) => row.ownerId === operator.userId),
  ).toMatchObject({ open: 1, overdue: 1, days14Plus: 1, oldestHours: 696 });
  expect(result.owners.find((row) => row.ownerId === null)).toMatchObject({
    open: 1,
    overdue: 0,
    under7Days: 1,
    oldestHours: 48,
  });
  expect(
    result.owners.find((row) => row.ownerId === owner.userId),
  ).toMatchObject({ open: 1, under7Days: 1, oldestHours: 24 });
});

it("denies requester/viewer access and excludes another company's records", async () => {
  for (const actor of [requester, viewer, { ...owner, userId: randomUUID() }])
    await expect(readInsights(actor, { days: 30 }, at)).rejects.toThrow();
  const result = await readInsights(other, { days: 30 }, at);
  expect(result.records.map((row) => row.title)).toEqual([
    "Other workspace secret",
  ]);
  expect(
    result.phases.find((row) => row.status === "needs_info"),
  ).toMatchObject({ requestCount: 1, totalHours: 720 });
  const empty = await readInsights(
    owner,
    { days: 30 },
    new Date("2020-01-01T00:00:00Z"),
  );
  expect(empty.records).toEqual([]);
  expect(
    empty.phases.every(
      (row) => row.requestCount === 0 && row.medianHours === null,
    ),
  ).toBe(true);
});

it("adds compact Exasol evidence only to internal model context and preserves old saved contexts", async () => {
  for (const actor of [owner, operator]) {
    const context = await readDatabase((sql) =>
      conversationContext(sql, actor, "Where are requests waiting?"),
    );
    expect(context.insights).toMatchObject({
      purpose: "explanatory_snapshot",
      days: 30,
      ownersHasMore: false,
    });
    expect(context.insights?.phases).toHaveLength(4);
    expect(context.insights?.evidence.map((item) => item.queryId)).toEqual([
      "request-phase-hours-v1",
      "weekly-request-flow-v1",
      "current-owner-aging-v1",
    ]);
    expect(context.insights).not.toHaveProperty("records");
    expect(context.insights!.flow.at(-1)!.weekStart).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
    expect(
      context.insights!.phases.some((phase) => phase.requestCount > 0),
    ).toBe(true);
    // Old context objects remain readable without manufacturing new values or
    // invalidating their original persisted integrity hash.
    delete context.insights;
    const now = sqlTimestamp(new Date().toISOString());
    const mapped = mapConversationTurn({
      ID: randomUUID(),
      WORKSPACE_ID: actor.workspaceId,
      USER_ID: actor.userId,
      COMMAND_ID: randomUUID(),
      PROMPT: context.prompt,
      VISIBILITY: "internal",
      STATE: "completed",
      PROVIDER: "loom",
      VERSION: 1,
      CONTEXT_HASH: digest(context),
      CONTEXT_JSON: JSON.stringify(context),
      RESULT_JSON: null,
      LEASE_UNTIL: null,
      CONNECTION_ID: null,
      CREATED_AT: now,
      UPDATED_AT: now,
    });
    expect(mapped.context).not.toHaveProperty("insights");
  }
  for (const actor of [requester, viewer]) {
    const context = await readDatabase((sql) =>
      conversationContext(sql, actor, "Show team workload"),
    );
    expect(context).not.toHaveProperty("insights");
    expect(context.knowledge).toEqual([]);
  }
});
