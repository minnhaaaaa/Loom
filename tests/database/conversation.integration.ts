import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  dataRequestTemplate,
  type Actor,
  type ModelInference,
} from "@loom/contracts";
import { isConfigured, readDatabase, writeDatabase } from "@loom/db-exasol";
import {
  createRequest,
  details,
  mutateRequest,
} from "../../apps/web/server/desk";
import {
  createKnowledge,
  changeKnowledge,
} from "../../apps/web/server/knowledge";
import {
  readConversation,
  sendConversation,
} from "../../apps/web/server/conversation";
import { reviewProposal } from "../../apps/web/server/triage";
import { conversationPromptVersion } from "../../apps/web/server/conversation-model";
import {
  getConversationTurn,
  type ConversationContext,
} from "../../apps/web/server/conversation-store";

const model = vi.hoisted(() => ({ infer: vi.fn(), design: vi.fn() }));
vi.mock("../../apps/web/server/conversation-model", async (original) => ({
  ...(await original<
    typeof import("../../apps/web/server/conversation-model")
  >()),
  inferConversation: (...args: unknown[]) => model.infer(...args),
}));
vi.mock("../../apps/web/server/tool-generation", async (original) => ({
  ...(await original<typeof import("../../apps/web/server/tool-generation")>()),
  generateDefinition: (...args: unknown[]) => model.design(...args),
}));
if (!isConfigured())
  throw new Error("Real Exasol is required for conversation integration.");
const ws = randomUUID(),
  otherWs = randomUUID();
const owner: Actor = { workspaceId: ws, userId: randomUUID() };
const requester: Actor = { workspaceId: ws, userId: randomUUID() };
const viewer: Actor = { workspaceId: ws, userId: randomUUID() };
const foreign: Actor = { workspaceId: otherWs, userId: owner.userId };
const inference: ModelInference = {
  requestedModel: "fixture/conversation:free",
  actualModel: "fixture/actual:free",
  generationId: "fixture",
  promptVersion: conversationPromptVersion,
  promptTokens: 10,
  completionTokens: 20,
  durationMs: 1,
  cost: 0,
};
const answer = {
  reply: "Provider fixture answer to the user's actual question.",
  evidenceIds: [] as string[],
  toolInstructions: null as string | null,
  proposals: [] as object[],
};
beforeAll(async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "public-fixture-key");
  vi.stubEnv("OPENROUTER_MODEL", inference.requestedModel);
  vi.stubEnv("OPENROUTER_TOOL_MODEL", inference.requestedModel);
  vi.stubEnv("OPENROUTER_FREE_ONLY", "true");
  await writeDatabase(async (sql) => {
    for (const id of [ws, otherWs])
      await sql.execute("INSERT INTO WORKSPACES (ID,NAME) VALUES (?,?)", [
        id,
        "Conversation integration fixture",
      ]);
    for (const [actor, role] of [
      [owner, "owner"],
      [requester, "requester"],
      [viewer, "viewer"],
      [foreign, "owner"],
    ] as const)
      await sql.execute(
        "INSERT INTO MEMBERSHIPS (WORKSPACE_ID,USER_ID,NAME,ROLE,ACTIVE,VERSION) VALUES (?,?,?,?,TRUE,1)",
        [actor.workspaceId, actor.userId, `Conversation ${role}`, role],
      );
  });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await writeDatabase(async (sql) => {
    for (const table of [
      "CONVERSATION_TURNS",
      "MODEL_ATTEMPTS",
      "AGENT_STEPS",
      "TRIAGE_PROPOSALS",
      "AGENT_RUNS",
      "AGENT_EVENTS",
      "KNOWLEDGE_ENTRIES",
      "TOOL_GENERATIONS",
      "TOOL_EVENTS",
      "TOOL_REVISIONS",
      "TOOL_DRAFTS",
      "TOOLS",
      "COMMENTS",
      "REQUEST_EVENTS",
      "AUDIT_EVENTS",
      "OUTBOX_EVENTS",
      "COMMAND_RECEIPTS",
      "REQUESTS",
      "MEMBERSHIPS",
      "WORKSPACES",
    ])
      for (const id of [ws, otherWs])
        await sql.execute(
          `DELETE FROM ${table} WHERE ${table === "WORKSPACES" ? "ID" : "WORKSPACE_ID"}=?`,
          [id],
        );
  });
});
it("persists open-ended answers in an empty workspace, scopes history, and reconciles repeated sends", async () => {
  model.infer.mockResolvedValue({ decision: answer, inference });
  const input = {
    commandId: randomUUID(),
    prompt: "Explain a useful project review in simple words.",
  };
  const first = await sendConversation(owner, input);
  expect(first.messages).toHaveLength(2);
  expect(first.messages[1]).toMatchObject({
    content: answer.reply,
    state: "complete",
    proposals: [],
  });
  expect(model.infer.mock.calls[0][0]).toMatchObject({
    prompt: input.prompt,
    records: [],
    allowProposals: true,
  });
  const callCount = model.infer.mock.calls.length;
  expect((await sendConversation(owner, input)).messages[1].id).toBe(
    first.messages[1].id,
  );
  expect(model.infer).toHaveBeenCalledTimes(callCount);
  await expect(
    sendConversation(owner, { ...input, prompt: "Different prompt" }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect((await readConversation(foreign)).messages).toEqual([]);
});
it("filters requester model context before inference and rejects invented authority", async () => {
  const own = await createRequest(requester, randomUUID(), {
    title: "Requester visible",
    businessQuestion: "Question visible to its author.",
    dataset: "",
    reportingPeriod: "",
  });
  await createRequest(owner, randomUUID(), {
    title: "Internal foreign request",
    businessQuestion: "Not visible to requester.",
    dataset: "",
    reportingPeriod: "",
  });
  const source = await createKnowledge(owner, randomUUID(), {
    title: "Secret context",
    kind: "procedure",
    content: "Internal source only.",
    dataset: "",
    ownerId: null,
    effectiveFrom: "2026-01-01",
    effectiveUntil: null,
    supersedesId: null,
  });
  await changeKnowledge(
    owner,
    source.id,
    randomUUID(),
    source.version,
    "approve",
  );
  model.infer.mockImplementation(async (context: ConversationContext) => {
    expect(context.knowledge).toEqual([]);
    expect(context.members).toEqual([]);
    expect(context.allowProposals).toBe(false);
    expect(context.records.map((record) => record.id)).toEqual([own.id]);
    expect(context.records[0]).not.toHaveProperty("priority");
    return {
      decision: {
        ...answer,
        proposals: [
          {
            requestId: own.id,
            expectedVersion: own.version,
            reasons: ["Invalid fixture action"],
            uncertainty: [],
            evidenceIds: [],
            commands: [{ type: "set_priority", priority: "high" }],
          },
        ],
      },
      inference,
    };
  });
  const result = await sendConversation(requester, {
    commandId: randomUUID(),
    prompt: "Change my priority",
  });
  expect(result.messages.at(-1)).toMatchObject({
    state: "failed",
    proposals: [],
  });
  expect((await details(owner, own.id)).request).toMatchObject({
    priority: "normal",
  });
});
it("hides former viewer answers and excludes them from requester inference history after a role downgrade", async () => {
  const privateReply = "PRIVATE VIEWER SUMMARY OF OTHER PEOPLE'S REQUESTS";
  model.infer.mockResolvedValue({
    decision: { ...answer, reply: privateReply },
    inference,
  });
  const previousInput = {
    commandId: randomUUID(),
    prompt: "Summarize every visible request for the viewer.",
  };
  const before = await sendConversation(viewer, previousInput);
  expect(before.messages.at(-1)!.content).toBe(privateReply);
  const turnId = before.messages.at(-1)!.id.split(":")[0];
  await writeDatabase((sql) =>
    sql.execute(
      'UPDATE MEMBERSHIPS SET "ROLE"=?,VERSION=VERSION+1 WHERE WORKSPACE_ID=? AND USER_ID=?',
      ["requester", ws, viewer.userId],
    ),
  );
  try {
    expect((await readConversation(viewer)).messages).toEqual([]);
    await expect(
      readDatabase((sql) => getConversationTurn(sql, viewer, turnId)),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(sendConversation(viewer, previousInput)).rejects.toMatchObject(
      {
        code: "ACCESS_DENIED",
      },
    );
    model.infer.mockImplementation(async (context: ConversationContext) => {
      expect(context.member.role).toBe("requester");
      expect(context.history).toEqual([]);
      expect(context.records).toEqual([]);
      return { decision: answer, inference };
    });
    const after = await sendConversation(viewer, {
      commandId: randomUUID(),
      prompt: "What can I see now?",
    });
    expect(after.messages).toHaveLength(2);
    expect(JSON.stringify(after)).not.toContain(privateReply);
  } finally {
    await writeDatabase((sql) =>
      sql.execute(
        'UPDATE MEMBERSHIPS SET "ROLE"=?,VERSION=VERSION+1 WHERE WORKSPACE_ID=? AND USER_ID=?',
        ["viewer", ws, viewer.userId],
      ),
    );
  }
});
it("keeps natural-language proposals inert until exact human review and blocks stale context", async () => {
  const record = await createRequest(owner, randomUUID(), {
    title: "Conversation proposal",
    businessQuestion: "Verify review boundary.",
    dataset: "",
    reportingPeriod: "",
  });
  model.infer.mockResolvedValue({
    decision: {
      ...answer,
      proposals: [
        {
          requestId: record.id,
          expectedVersion: record.version,
          reasons: ["User requested this synthetic change."],
          uncertainty: [],
          evidenceIds: [],
          commands: [{ type: "set_priority", priority: "high" }],
        },
      ],
    },
    inference,
  });
  const result = await sendConversation(owner, {
    commandId: randomUUID(),
    prompt: "Raise the priority of the conversation proposal.",
  });
  const proposal = result.messages.at(-1)!.proposals![0];
  expect(proposal.content.engine).toBe("conversation-v1");
  expect((await details(owner, record.id)).request).toMatchObject({
    priority: "normal",
  });
  await reviewProposal(
    owner,
    proposal.content.id,
    randomUUID(),
    proposal.hash,
    "approve",
  );
  expect((await details(owner, record.id)).request).toMatchObject({
    priority: "high",
  });
  expect(
    (await readConversation(owner)).messages.at(-1)!.proposals![0].state,
  ).toBe("applied");
  model.infer.mockImplementation(async () => {
    const current = (await details(owner, record.id)).request;
    await mutateRequest(owner, record.id, randomUUID(), current.version, {
      type: "set_priority",
      priority: "low",
    });
    return { decision: answer, inference };
  });
  const stale = await sendConversation(owner, {
    commandId: randomUUID(),
    prompt: "Summarize the current queue.",
  });
  expect(stale.messages.at(-1)).toMatchObject({
    state: "failed",
    proposals: [],
  });
  expect(stale.messages.at(-1)!.content).toContain("record changed");
});
it("routes owner tool design through immutable drafts and hides internal chat after demotion", async () => {
  model.infer.mockResolvedValue({
    decision: {
      ...answer,
      toolInstructions: "Create a project review tracker.",
    },
    inference,
  });
  model.design.mockResolvedValue({
    spec: { ...dataRequestTemplate, title: "Conversation-designed tracker" },
    assumptions: [],
    unsupported: [],
    inference: { ...inference, promptVersion: "fixture-designer" },
  });
  const result = await sendConversation(owner, {
    commandId: randomUUID(),
    prompt: "I need a tracker for project reviews.",
  });
  expect(result.messages.at(-1)!.toolDraft?.spec.title).toBe(
    "Conversation-designed tracker",
  );
  expect(result.messages.at(-1)!.toolDraft?.baseRevision).toBe(1);
  await writeDatabase((sql) =>
    sql.execute(
      'UPDATE MEMBERSHIPS SET "ROLE"=?,VERSION=VERSION+1 WHERE WORKSPACE_ID=? AND USER_ID=?',
      ["operator", ws, owner.userId],
    ),
  );
  expect((await readConversation(owner)).messages).toEqual([]);
  model.infer.mockImplementation(async (context: ConversationContext) => {
    expect(context.member.role).toBe("operator");
    expect(context.history).toEqual([]);
    expect(context.allowToolDesign).toBe(false);
    return { decision: answer, inference };
  });
  const operatorReply = await sendConversation(owner, {
    commandId: randomUUID(),
    prompt: "Explain the work I can access as an operator.",
  });
  expect(operatorReply.messages).toHaveLength(2);
  expect(operatorReply.messages.at(-1)!.toolDraft).toBeUndefined();
  await writeDatabase((sql) =>
    sql.execute(
      'UPDATE MEMBERSHIPS SET "ROLE"=? WHERE WORKSPACE_ID=? AND USER_ID=?',
      ["viewer", ws, owner.userId],
    ),
  );
  expect((await readConversation(owner)).messages).toEqual([]);
});
