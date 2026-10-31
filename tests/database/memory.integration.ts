import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  dataRequestTemplate,
  type Actor,
  type KnowledgeInput,
} from "@loom/contracts";
import { isConfigured, writeDatabase } from "@loom/db-exasol";
import { createRequest, mutateRequest } from "../../apps/web/server/desk";
import {
  createKnowledge,
  changeKnowledge,
} from "../../apps/web/server/knowledge";
import { readTeamMemory } from "../../apps/web/server/memory";
import { createToolDraft, publishTool } from "../../apps/web/server/tools";
import { changeMembership } from "../../apps/web/server/workspaces";

if (!isConfigured())
  throw new Error("Live Exasol is required for memory integration tests.");
const workspaceId = randomUUID(),
  otherWorkspaceId = randomUUID();
const owner: Actor = { workspaceId, userId: randomUUID() };
const requester: Actor = { workspaceId, userId: randomUUID() };
const operator: Actor = { workspaceId, userId: randomUUID() };
const outsider: Actor = { workspaceId: otherWorkspaceId, userId: owner.userId };
const day = new Date().toISOString().slice(0, 10);
let approvedId: string, recordId: string;
function knowledge(title: string): KnowledgeInput {
  return {
    title,
    kind: "procedure",
    content:
      "Use the onboarding checklist to prepare access before the start date.",
    dataset: "People",
    ownerId: null,
    effectiveFrom: day,
    effectiveUntil: null,
    supersedesId: null,
  };
}
beforeAll(async () => {
  await writeDatabase(async (sql) => {
    for (const id of [workspaceId, otherWorkspaceId])
      await sql.execute("INSERT INTO WORKSPACES (ID,NAME) VALUES (?,?)", [
        id,
        "Team memory integration fixture",
      ]);
    for (const [actor, role] of [
      [owner, "owner"],
      [requester, "requester"],
      [operator, "operator"],
      [outsider, "owner"],
    ] as const)
      await sql.execute(
        "INSERT INTO MEMBERSHIPS (WORKSPACE_ID,USER_ID,NAME,ROLE,ACTIVE) VALUES (?,?,?,?,TRUE)",
        [actor.workspaceId, actor.userId, "Memory fixture", role],
      );
  });
  const draft = await createToolDraft(owner, randomUUID(), 1, {
    ...dataRequestTemplate,
    title: "Memory fixture desk",
  });
  await publishTool(owner, randomUUID(), draft.id, 1, draft.hash);
  await changeMembership(
    owner,
    operator.userId,
    randomUUID(),
    1,
    "viewer",
    true,
  );
  const approved = await createKnowledge(
    owner,
    randomUUID(),
    knowledge("Onboarding checklist"),
  );
  await changeKnowledge(
    owner,
    approved.id,
    randomUUID(),
    approved.version,
    "approve",
  );
  approvedId = approved.id;
  await createKnowledge(owner, randomUUID(), knowledge("Unapproved checklist"));
  const retired = await createKnowledge(
    owner,
    randomUUID(),
    knowledge("Retired checklist"),
  );
  await changeKnowledge(
    owner,
    retired.id,
    randomUUID(),
    retired.version,
    "retire",
  );
  const foreign = await createKnowledge(
    outsider,
    randomUUID(),
    knowledge("Foreign checklist"),
  );
  await changeKnowledge(
    outsider,
    foreign.id,
    randomUUID(),
    foreign.version,
    "approve",
  );
  const request = await createRequest(requester, randomUUID(), {
    title: "Prepare a new joiner",
    businessQuestion: "Prepare the onboarding checklist.",
    reportingPeriod: day,
    dataset: "People",
  });
  recordId = request.id;
  await mutateRequest(owner, request.id, randomUUID(), request.version, {
    type: "set_owner",
    ownerId: owner.userId,
  });
});
afterAll(async () => {
  await writeDatabase(async (sql) => {
    for (const table of [
      "AGENT_EVENTS",
      "KNOWLEDGE_ENTRIES",
      "COMMENTS",
      "REQUEST_EVENTS",
      "AUDIT_EVENTS",
      "OUTBOX_EVENTS",
      "TOOL_EVENTS",
      "TOOL_REVISIONS",
      "TOOL_DRAFTS",
      "TOOLS",
      "WORKSPACE_EVENTS",
      "COMMAND_RECEIPTS",
      "REQUESTS",
      "MEMBERSHIPS",
      "WORKSPACES",
    ])
      for (const id of [workspaceId, otherWorkspaceId])
        await sql.execute(
          `DELETE FROM ${table} WHERE ${table === "WORKSPACES" ? "ID" : "WORKSPACE_ID"} = ?`,
          [id],
        );
  });
});

it("retrieves approved scoped evidence and factual ownership/history from real Exasol", async () => {
  const memory = await readTeamMemory(owner, {
    q: "checklist",
    dataset: "People",
    asOf: day,
  });
  expect(memory.entries.map((hit) => hit.entry.id)).toEqual([approvedId]);
  expect(memory.graph.edges).toContainEqual(
    expect.objectContaining({
      from: `request:${recordId}`,
      to: `person:${owner.userId}`,
      relation: "assigned_to",
      evidence: { resourceId: recordId, version: 2, source: "request-record" },
    }),
  );
  expect(
    memory.timeline.some(
      (event) =>
        event.action === "knowledge_approved" &&
        event.resourceId === approvedId,
    ),
  ).toBe(true);
  expect(memory.timeline.some((event) => event.resourceId === recordId)).toBe(
    true,
  );
  expect(
    memory.timeline.some((event) => event.action === "tool_published"),
  ).toBe(true);
  expect(
    memory.timeline.some((event) => event.resourceId === operator.userId),
  ).toBe(true);
  expect(memory.hasMore).toEqual({
    knowledge: false,
    requests: false,
    proposals: false,
    events: false,
  });
  expect(
    (await readTeamMemory(owner, { q: approvedId })).entries[0].entry.id,
  ).toBe(approvedId);
  expect(
    (await readTeamMemory(owner, { q: "missing-telemetry" })).entries,
  ).toEqual([]);
  await expect(readTeamMemory(requester)).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  await expect(
    readTeamMemory({ ...owner, userId: randomUUID() }),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  expect(
    (await readTeamMemory(outsider)).entries.every(
      (hit) => hit.entry.workspaceId === otherWorkspaceId,
    ),
  ).toBe(true);
});
