import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import {
  personas,
  workspaceId,
  type Actor,
  type KnowledgeInput,
  type ProposalContent,
  type ProposalKnowledgeInput,
} from "@loom/contracts";
import { sampleRequests } from "../packages/contracts/src/fixtures";

const db = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn() }));
vi.mock("@loom/db-exasol", async (original) => ({
  ...(await original<typeof import("@loom/db-exasol")>()),
  readDatabase: async (work: (sql: typeof db) => unknown) => work(db),
  writeDatabase: async (work: (sql: typeof db) => unknown) => work(db),
}));
import { digest } from "../apps/web/server/desk";
import {
  changeKnowledge,
  createKnowledge,
  createKnowledgeFromProposal,
} from "../apps/web/server/knowledge";

const actor: Actor = { workspaceId, userId: personas[1].id };
let role: string;
let source: Record<string, unknown>;
let requestVersion: number;
let definitionRevision: number | null;
let content: ProposalContent;
const entries = new Map<string, Record<string, unknown>>();
const receipts = new Map<string, Record<string, unknown>>();
function input(hash = String(source.CONTENT_HASH)): ProposalKnowledgeInput {
  return {
    commandId: randomUUID(),
    hash,
    title: "Check the reporting window before assigning work",
    body: "Ask the requester to confirm the reporting window before assigning an analyst.",
    rationale:
      "The reviewed case showed that an unclear window led to repeated clarification.",
    kind: "procedure",
  };
}
beforeEach(() => {
  role = "operator";
  requestVersion = 2;
  definitionRevision = null;
  entries.clear();
  receipts.clear();
  const before = { ...sampleRequests[0], version: 1 };
  content = {
    workspaceId,
    id: randomUUID(),
    runId: randomUUID(),
    revision: 1,
    initiatorId: personas[0].id,
    engine: "openrouter-v1",
    inference: {
      requestedModel: "fixture/model",
      actualModel: "fixture/model",
      generationId: "fixture-only",
      promptVersion: "fixture",
      promptTokens: null,
      completionTokens: null,
      cost: null,
      durationMs: 1,
    },
    toolRevision: "request-desk-v1",
    requestId: before.id,
    expectedVersion: 1,
    before,
    commands: [{ type: "set_priority", priority: "low" }],
    after: { ...before, version: 2, priority: "low" },
    evidence: [],
    knowledgeDigest: digest([]),
    reasons: ["Reviewed case"],
    uncertainty: [],
    expiresAt: "2026-10-20T00:00:00.000Z",
  };
  source = {
    ID: content.id,
    WORKSPACE_ID: workspaceId,
    RUN_ID: content.runId,
    REQUEST_ID: content.requestId,
    CONTENT_JSON: JSON.stringify(content),
    CONTENT_HASH: digest(content),
    LIFECYCLE: "applied",
    REVIEWED_BY: personas[0].id,
  };
  db.query
    .mockReset()
    .mockImplementation(async (sql: string, values: unknown[]) => {
      if (sql.includes("FROM MEMBERSHIPS"))
        return [{ USER_ID: actor.userId, NAME: "Operator", ROLE: role }];
      if (sql.includes("FROM COMMAND_RECEIPTS"))
        return receipts.has(String(values[1]))
          ? [receipts.get(String(values[1]))]
          : [];
      if (sql.includes("FROM TRIAGE_PROPOSALS"))
        return values[0] === workspaceId && values[1] === source.ID
          ? [source]
          : [];
      if (sql.includes("FROM REQUESTS R"))
        return [
          {
            ...Object.fromEntries(
              Object.entries(content.after).map(([key, value]) => [key, value]),
            ),
            ID: content.requestId,
            WORKSPACE_ID: workspaceId,
            TITLE: content.after.title,
            BUSINESS_QUESTION: content.after.businessQuestion,
            REPORTING_PERIOD: content.after.reportingPeriod,
            DATASET: content.after.dataset,
            CUSTOM_VALUES_JSON: "{}",
            REQUESTER_ID: content.after.requesterId,
            REQUESTER_NAME: content.after.requesterName,
            OWNER_ID: content.after.ownerId,
            OWNER_NAME: content.after.ownerName,
            PRIORITY: content.after.priority,
            STATUS: content.after.status,
            DUE_AT: content.after.dueAt,
            VERSION: requestVersion,
            CREATED_AT: content.after.createdAt,
            UPDATED_AT: content.after.updatedAt,
          },
        ];
      if (sql.includes("FROM TOOLS"))
        return definitionRevision
          ? [{ CURRENT_REVISION: definitionRevision }]
          : [];
      if (sql.includes("FROM KNOWLEDGE_ENTRIES"))
        return entries.has(String(values[1]))
          ? [entries.get(String(values[1]))]
          : [];
      return [];
    });
  db.execute
    .mockReset()
    .mockImplementation(async (sql: string, values: unknown[]) => {
      if (sql.startsWith("INSERT INTO KNOWLEDGE_ENTRIES")) {
        entries.set(String(values[1]), {
          WORKSPACE_ID: values[0],
          ID: values[1],
          VERSION: 1,
          LIFECYCLE: "draft",
          KIND: values[2],
          DATASET: values[3],
          CONTENT_JSON: values[4],
          CONTENT_HASH: values[5],
          CREATED_BY: values[6],
          CREATED_AT: values[7],
          APPROVED_BY: null,
        });
      }
      if (sql.startsWith("INSERT INTO COMMAND_RECEIPTS"))
        receipts.set(String(values[1]), {
          ACTOR_ID: values[2],
          PAYLOAD_HASH: values[3],
          RESULT_JSON: values[4],
        });
      if (sql.startsWith("UPDATE KNOWLEDGE_ENTRIES")) {
        const row = entries.get(String(values[3]))!;
        row.LIFECYCLE = values[0];
        row.APPROVED_BY = values[1];
        row.VERSION = Number(row.VERSION) + 1;
      }
      return 1;
    });
});

it("records a human-authored rule as a draft with verified immutable decision provenance", async () => {
  const values = input();
  const draft = await createKnowledgeFromProposal(actor, content.id, values);
  expect(draft).toMatchObject({
    state: "draft",
    approvedBy: null,
    title: values.title,
    content: values.body,
    dataset: content.after.dataset,
    provenance: {
      proposalId: content.id,
      proposalHash: source.CONTENT_HASH,
      runId: content.runId,
      requestId: content.requestId,
      requestVersion: 2,
      reviewedBy: personas[0].id,
      recordedBy: actor.userId,
      rationale: values.rationale,
    },
  });
  // A lost acknowledgement is reconciled even if the record changes later.
  requestVersion = 3;
  expect(
    (await createKnowledgeFromProposal(actor, content.id, values)).id,
  ).toBe(draft.id);
  expect(entries.size).toBe(1);
  await expect(
    createKnowledgeFromProposal(actor, content.id, {
      ...values,
      body: "Different rule",
    }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});

it("requires an operator and a matching applied proposal in the same workspace", async () => {
  for (const deniedRole of ["viewer", "requester"]) {
    role = deniedRole;
    await expect(
      createKnowledgeFromProposal(actor, content.id, input()),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  }
  role = "operator";
  await expect(
    createKnowledgeFromProposal(
      { ...actor, workspaceId: randomUUID() },
      content.id,
      input(),
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    createKnowledgeFromProposal(actor, content.id, input("0".repeat(64))),
  ).rejects.toMatchObject({ code: "PROPOSAL_HASH" });
  for (const state of ["pending", "rejected"]) {
    source.LIFECYCLE = state;
    await expect(
      createKnowledgeFromProposal(actor, content.id, input()),
    ).rejects.toMatchObject({ code: "DECISION_NOT_REVIEWED" });
  }
  expect(entries.size).toBe(0);
});

it("blocks changed source records and requires a separate owner approval", async () => {
  requestVersion = 3;
  await expect(
    createKnowledgeFromProposal(actor, content.id, input()),
  ).rejects.toMatchObject({ code: "STALE_DECISION" });
  requestVersion = 2;
  const draft = await createKnowledgeFromProposal(actor, content.id, input());
  await expect(
    changeKnowledge(actor, draft.id, randomUUID(), 1, "approve"),
  ).rejects.toThrow("Only an owner");
  role = "owner";
  requestVersion = 3;
  await expect(
    changeKnowledge(actor, draft.id, randomUUID(), 1, "approve"),
  ).rejects.toMatchObject({ code: "STALE_DECISION" });
  requestVersion = 2;
  const approved = await changeKnowledge(
    actor,
    draft.id,
    randomUUID(),
    1,
    "approve",
  );
  expect(approved).toMatchObject({
    state: "approved",
    version: 2,
    approvedBy: actor.userId,
  });
});

it("rejects forged provenance submitted through ordinary knowledge creation", async () => {
  const draft = await createKnowledgeFromProposal(actor, content.id, input());
  const values: KnowledgeInput = {
    title: draft.title,
    content: draft.content,
    kind: draft.kind,
    dataset: draft.dataset,
    ownerId: null,
    effectiveFrom: draft.effectiveFrom,
    effectiveUntil: null,
    supersedesId: null,
    provenance: draft.provenance,
  };
  await expect(
    createKnowledge(actor, randomUUID(), values),
  ).rejects.toMatchObject({ code: "KNOWLEDGE_PROVENANCE" });
  expect(entries.size).toBe(1);
  const replacement = { ...values };
  delete replacement.provenance;
  const revised = await createKnowledge(actor, randomUUID(), {
    ...replacement,
    title: "Revised human guidance",
    supersedesId: draft.id,
  });
  expect(revised.provenance).toEqual(draft.provenance);
});
