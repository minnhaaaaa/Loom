import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Client } from "../../apps/web/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "../../apps/web/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";
import {
  dataRequestTemplate,
  type Actor,
  type ExternalTaskReplyInput,
} from "@loom/contracts";
import {
  isConfigured,
  readDatabase,
  sqlTimestamp,
  writeDatabase,
} from "@loom/db-exasol";
import {
  createRequest,
  details,
  digest,
  mutateRequest,
} from "../../apps/web/server/desk";
import {
  createAgentConnection,
  revokeAgentConnection,
  readWorkspaceSettings,
  updateWorkspaceSettings,
} from "../../apps/web/server/settings";
import { conversationConfiguration } from "../../apps/web/server/conversation";
import { handleMcpRequest } from "../../apps/web/server/mcp";
import {
  conversationContext,
  conversationMessagesFor,
} from "../../apps/web/server/conversation-store";
import {
  listExternalTasks,
  proposeExternalTool,
  replyExternalTask,
} from "../../apps/web/server/external-tasks";
import {
  createExternalProposal,
  externalWorkspace,
} from "../../apps/web/server/external-agent";
import { reviewProposal } from "../../apps/web/server/triage";

if (!isConfigured())
  throw new Error(
    "Apply migration008 and configure real Exasol before this suite.",
  );
const workspaceId = randomUUID(),
  foreignWorkspaceId = randomUUID();
const owner: Actor = { workspaceId, userId: randomUUID() },
  operator: Actor = { workspaceId, userId: randomUUID() },
  requester: Actor = { workspaceId, userId: randomUUID() },
  foreign: Actor = { workspaceId: foreignWorkspaceId, userId: randomUUID() };
let token: string;

beforeAll(async () => {
  vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
  await writeDatabase(async (sql) => {
    for (const id of [workspaceId, foreignWorkspaceId])
      await sql.execute("INSERT INTO WORKSPACES (ID,NAME) VALUES (?,?)", [
        id,
        "Prompt MCP task fixture",
      ]);
    for (const [actor, role] of [
      [owner, "owner"],
      [operator, "operator"],
      [requester, "requester"],
      [foreign, "owner"],
    ] as const)
      await sql.execute(
        "INSERT INTO MEMBERSHIPS (WORKSPACE_ID,USER_ID,NAME,ROLE,ACTIVE,VERSION) VALUES (?,?,?,?,TRUE,1)",
        [actor.workspaceId, actor.userId, `Prompt ${role}`, role],
      );
  });
  token = (
    await createAgentConnection(owner, {
      commandId: randomUUID(),
      label: "Prompt client",
      client: "codex",
    })
  ).token!;
});
afterAll(async () => {
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
      "TOOL_DRAFTS",
      "TOOL_REVISIONS",
      "TOOLS",
      "AGENT_CONNECTIONS",
      "WORKSPACE_SETTINGS",
      "WORKSPACE_EVENTS",
      "COMMENTS",
      "REQUEST_EVENTS",
      "AUDIT_EVENTS",
      "OUTBOX_EVENTS",
      "COMMAND_RECEIPTS",
      "REQUESTS",
      "MEMBERSHIPS",
      "WORKSPACES",
    ])
      for (const id of [workspaceId, foreignWorkspaceId])
        await sql.execute(
          `DELETE FROM ${table} WHERE ${table === "WORKSPACES" ? "ID" : "WORKSPACE_ID"}=?`,
          [id],
        );
  });
  vi.unstubAllEnvs();
});
async function queued(author: Actor, prompt: string, provider = "codex") {
  return writeDatabase(async (sql) => {
    const context = await conversationContext(sql, author, prompt);
    const id = randomUUID(),
      now = sqlTimestamp(new Date().toISOString()),
      contextHash = digest(context);
    await sql.execute(
      "INSERT INTO CONVERSATION_TURNS (WORKSPACE_ID,ID,USER_ID,COMMAND_ID,PROMPT,VISIBILITY,\"STATE\",PROVIDER,VERSION,CONTEXT_HASH,CONTEXT_JSON,CREATED_AT,UPDATED_AT) VALUES (?,?,?,?,?,'internal','queued',?,1,?,?,?,?)",
      [
        author.workspaceId,
        id,
        author.userId,
        randomUUID(),
        prompt,
        provider,
        contextHash,
        JSON.stringify(context),
        now,
        now,
      ],
    );
    return { id, contextHash, context, version: 1 };
  });
}
function response(
  task: Awaited<ReturnType<typeof queued>>,
  values: Partial<ExternalTaskReplyInput> = {},
): ExternalTaskReplyInput {
  return {
    commandId: randomUUID(),
    taskId: task.id,
    expectedVersion: task.version,
    contextHash: task.contextHash,
    reply: "Here is the current workspace summary.",
    evidenceIds: [],
    proposalIds: [],
    ...values,
  };
}
function decode<T>(value: unknown): T {
  const text = (value as { content: { text?: string }[] }).content[0]?.text;
  if (!text) throw new Error("Missing MCP result.");
  return JSON.parse(text) as T;
}
function sdk() {
  const client = new Client({ name: "Prompt inbox SDK fixture", version: "1" });
  const transport = new StreamableHTTPClientTransport(
    new URL("http://localhost:3000/api/mcp"),
    {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: (input, init) => handleMcpRequest(new Request(input, init)),
      reconnectionOptions: {
        initialReconnectionDelay: 1,
        maxReconnectionDelay: 1,
        maxRetries: 0,
        reconnectionDelayGrowFactor: 1,
      },
    },
  );
  return { client, transport };
}

it("roundtrips an operator's prompt through the SDK, attaches exact task proposals, and preserves owner tool drafts", async () => {
  const record = await createRequest(operator, randomUUID(), {
    title: "Review this onboarding item",
    businessQuestion: "Prepare access for a joiner.",
    dataset: "People",
    reportingPeriod: "Next month",
  });
  const task = await queued(
    operator,
    "Review this onboarding item and suggest what needs attention.",
  );
  const { client, transport } = sdk();
  try {
    await client.connect(transport);
    const inbox = decode<{ tasks: { id: string }[] }>(
      await client.callTool({ name: "loom_list_tasks", arguments: {} }),
    );
    expect(inbox.tasks.map((item) => item.id)).toContain(task.id);
    const workspace = await externalWorkspace(token);
    const proposal = await createExternalProposal(token, {
      commandId: randomUUID(),
      taskId: task.id,
      requestId: record.id,
      expectedVersion: record.version,
      toolRevision: workspace.tool.revision,
      knowledgeDigest: workspace.knowledgeDigest,
      summary: "Review priority.",
      reasons: ["The operator requested a human review of priority."],
      uncertainty: ["No policy evidence is available."],
      evidenceIds: [],
      commands: [{ type: "set_priority", priority: "high" }],
    });
    const unrelated = await queued(
      operator,
      "A separate prompt must not inherit another prompt's proposal.",
    );
    await expect(
      replyExternalTask(
        token,
        response(unrelated, { proposalIds: [proposal.proposalId] }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_TASK_PROPOSAL" });
    const input = response(task, { proposalIds: [proposal.proposalId] });
    const result = decode<{ state: string }>(
      await client.callTool({ name: "loom_reply_task", arguments: input }),
    );
    expect(result.state).toBe("completed");
    const messages = await readDatabase((sql) =>
      conversationMessagesFor(sql, operator),
    );
    const answer = messages.messages.find(
      (message) => message.id === `${task.id}:assistant`,
    )!;
    expect(answer.content).toBe(input.reply);
    expect(answer.proposals?.[0]).toMatchObject({
      state: "pending",
      content: {
        sourceTaskId: task.id,
        sourceConnectionId: workspace.connection.id,
      },
    });
    expect((await details(operator, record.id)).request).toMatchObject({
      priority: "normal",
    });
    await reviewProposal(
      operator,
      proposal.proposalId,
      randomUUID(),
      proposal.hash,
      "approve",
    );
    expect((await details(operator, record.id)).request).toMatchObject({
      priority: "high",
    });
    expect(await replyExternalTask(token, input)).toMatchObject({
      state: "completed",
      replayed: true,
    });

    const ownerTask = await queued(
      owner,
      "Make the tool name fit our people team.",
    );
    const draftInput = {
      commandId: randomUUID(),
      taskId: ownerTask.id,
      expectedTaskVersion: 1,
      contextHash: ownerTask.contextHash,
      expectedRevision: workspace.tool.revision,
      spec: { ...dataRequestTemplate, title: "People team requests" },
    };
    const prepared = await proposeExternalTool(token, draftInput);
    expect(prepared.version).toBe(2);
    expect((await externalWorkspace(token)).tool.spec.title).toBe(
      dataRequestTemplate.title,
    );
    expect((await proposeExternalTool(token, draftInput)).toolDraft.id).toBe(
      prepared.toolDraft.id,
    );
    await replyExternalTask(
      token,
      response(ownerTask, {
        expectedVersion: 2,
        reply: "I prepared a tool draft for you to review.",
      }),
    );
    const ownerMessages = await readDatabase((sql) =>
      conversationMessagesFor(sql, owner),
    );
    expect(
      ownerMessages.messages.find(
        (message) => message.id === `${ownerTask.id}:assistant`,
      )?.toolDraft?.hash,
    ).toBe(prepared.toolDraft.hash);
  } finally {
    await client.close();
  }
});

it("denies member/foreign/mismatched tasks, preserves exact lineage and fails stale replies without delivering agent text", async () => {
  const task = await queued(
    operator,
    "Summarize the current onboarding items.",
  );
  const blocked = await queued(
    requester,
    "This must not be visible to an owner-level agent.",
  );
  const other = await queued(foreign, "Another workspace's prompt.");
  const wrongClient = await queued(
    operator,
    "A Claude-only prompt.",
    "claude-code",
  );
  const inbox = await listExternalTasks(token);
  const ids = inbox.tasks.map((item) => item.id);
  expect(ids).toContain(task.id);
  expect(ids).not.toContain(blocked.id);
  expect(ids).not.toContain(other.id);
  expect(ids).not.toContain(wrongClient.id);
  for (const id of [other.id, wrongClient.id])
    await expect(
      replyExternalTask(token, { ...response(task), taskId: id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    replyExternalTask(token, response(blocked)),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  await expect(
    proposeExternalTool(token, {
      commandId: randomUUID(),
      taskId: task.id,
      expectedTaskVersion: 1,
      contextHash: task.contextHash,
      expectedRevision: 1,
      spec: dataRequestTemplate,
    }),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  await expect(
    replyExternalTask(token, response(task, { expectedVersion: 9 })),
  ).rejects.toMatchObject({ code: "AGENT_TASK_CONFLICT" });
  const record = task.context.records[0];
  await mutateRequest(operator, record.id, randomUUID(), record.version, {
    type: "set_priority",
    priority: "low",
  });
  const input = response(task, {
    reply: "STALE AGENT CONTENT MUST NOT BE SAVED",
  });
  expect(await replyExternalTask(token, input)).toMatchObject({
    state: "failed",
    error: "STALE_CONVERSATION",
  });
  expect(await replyExternalTask(token, input)).toMatchObject({
    state: "failed",
    replayed: true,
  });
  const messages = await readDatabase((sql) =>
    conversationMessagesFor(sql, operator),
  );
  const answer = messages.messages.find(
    (message) => message.id === `${task.id}:assistant`,
  )!;
  expect(answer.state).toBe("failed");
  expect(answer.content).not.toContain("STALE AGENT CONTENT");

  const pending = await queued(operator, "Wait for a revoked client.");
  const connection = await createAgentConnection(owner, {
    commandId: randomUUID(),
    label: "Revoked prompt client",
    client: "codex",
  });
  await revokeAgentConnection(owner, connection.connection.id, randomUUID(), 1);
  await expect(
    replyExternalTask(connection.token!, response(pending)),
  ).rejects.toMatchObject({ code: "AGENT_UNAUTHORIZED" });
  await writeDatabase((sql) =>
    sql.execute(
      'UPDATE MEMBERSHIPS SET "ROLE"=? WHERE WORKSPACE_ID=? AND USER_ID=?',
      ["requester", workspaceId, operator.userId],
    ),
  );
  try {
    expect(
      (await listExternalTasks(token)).tasks.map((item) => item.id),
    ).not.toContain(pending.id);
    await expect(
      replyExternalTask(token, response(pending)),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(
      (await readDatabase((sql) => conversationMessagesFor(sql, operator)))
        .messages,
    ).toEqual([]);
  } finally {
    await writeDatabase((sql) =>
      sql.execute(
        'UPDATE MEMBERSHIPS SET "ROLE"=? WHERE WORKSPACE_ID=? AND USER_ID=?',
        ["operator", workspaceId, operator.userId],
      ),
    );
  }
});

it("hides saved owner context after the author becomes an operator", async () => {
  await writeDatabase((sql) =>
    sql.execute(
      'UPDATE MEMBERSHIPS SET "ROLE"=? WHERE WORKSPACE_ID=? AND USER_ID=?',
      ["owner", workspaceId, operator.userId],
    ),
  );
  const task = await queued(operator, "Prepare an owner-only tool change.");
  await writeDatabase((sql) =>
    sql.execute(
      'UPDATE MEMBERSHIPS SET "ROLE"=? WHERE WORKSPACE_ID=? AND USER_ID=?',
      ["operator", workspaceId, operator.userId],
    ),
  );
  const current = await queued(
    operator,
    "Summarize the workspace with my current role.",
  );
  const ids = (await listExternalTasks(token)).tasks.map((item) => item.id);
  expect(ids).not.toContain(task.id);
  expect(ids).toContain(current.id);
  await expect(replyExternalTask(token, response(task))).rejects.toMatchObject({
    code: "CONVERSATION_ACCESS_CHANGED",
  });
  await expect(
    proposeExternalTool(token, {
      commandId: randomUUID(),
      taskId: task.id,
      expectedTaskVersion: 1,
      contextHash: task.contextHash,
      expectedRevision: task.context.tool.revision,
      spec: dataRequestTemplate,
    }),
  ).rejects.toMatchObject({ code: "CONVERSATION_ACCESS_CHANGED" });
});

it("only enables external prompts with a live matching connection from a current owner", async () => {
  const settings = await readWorkspaceSettings(foreign);
  await updateWorkspaceSettings(foreign, {
    commandId: randomUUID(),
    expectedVersion: settings.version,
    branding: settings.branding,
    preferredAgent: "codex",
    completeSetup: false,
  });
  const config = () =>
    readDatabase((sql) => conversationConfiguration(sql, foreign));
  expect(await config()).toMatchObject({
    configured: false,
    mode: "unavailable",
    provider: "codex",
  });
  await createAgentConnection(foreign, {
    commandId: randomUUID(),
    label: "Wrong client",
    client: "claude-code",
  });
  expect((await config()).configured).toBe(false);
  const connection = await createAgentConnection(foreign, {
    commandId: randomUUID(),
    label: "Matching client",
    client: "codex",
  });
  expect(await config()).toMatchObject({ configured: true, mode: "external" });
  await writeDatabase((sql) =>
    sql.execute("UPDATE AGENT_CONNECTIONS SET EXPIRES_AT=? WHERE ID=?", [
      sqlTimestamp(new Date(Date.now() - 1000).toISOString()),
      connection.connection.id,
    ]),
  );
  expect((await config()).configured).toBe(false);
  await writeDatabase((sql) =>
    sql.execute("UPDATE AGENT_CONNECTIONS SET EXPIRES_AT=? WHERE ID=?", [
      sqlTimestamp(new Date(Date.now() + 60_000).toISOString()),
      connection.connection.id,
    ]),
  );
  await writeDatabase((sql) =>
    sql.execute(
      'UPDATE MEMBERSHIPS SET "ROLE"=? WHERE WORKSPACE_ID=? AND USER_ID=?',
      ["operator", foreign.workspaceId, foreign.userId],
    ),
  );
  try {
    expect((await config()).configured).toBe(false);
  } finally {
    await writeDatabase((sql) =>
      sql.execute(
        'UPDATE MEMBERSHIPS SET "ROLE"=? WHERE WORKSPACE_ID=? AND USER_ID=?',
        ["owner", foreign.workspaceId, foreign.userId],
      ),
    );
  }
  expect((await config()).configured).toBe(true);
  await revokeAgentConnection(
    foreign,
    connection.connection.id,
    randomUUID(),
    connection.connection.version,
  );
  expect((await config()).configured).toBe(false);
});
