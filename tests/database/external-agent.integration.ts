import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Client } from "../../apps/web/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "../../apps/web/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";
import type {
  Actor,
  ExternalProposalInput,
  PublishedTool,
  RunDetails,
} from "@loom/contracts";
import { isConfigured, readDatabase, writeDatabase } from "@loom/db-exasol";
import { createRequest, details } from "../../apps/web/server/desk";
import {
  changeKnowledge,
  createKnowledge,
  createKnowledgeFromProposal,
} from "../../apps/web/server/knowledge";
import {
  createAgentConnection,
  revokeAgentConnection,
} from "../../apps/web/server/settings";
import { handleMcpRequest } from "../../apps/web/server/mcp";
import {
  createExternalProposal,
  externalWorkspace,
} from "../../apps/web/server/external-agent";
import {
  changeRun,
  listRuns,
  readRun,
  reviewProposal,
} from "../../apps/web/server/triage";

if (!isConfigured())
  throw new Error(
    "Configure real Exasol and apply migration007 before this suite.",
  );
const workspaceId = randomUUID(),
  foreignWorkspaceId = randomUUID();
const owner: Actor = { workspaceId, userId: randomUUID() },
  operator: Actor = { workspaceId, userId: randomUUID() },
  requester: Actor = { workspaceId, userId: randomUUID() },
  foreign: Actor = { workspaceId: foreignWorkspaceId, userId: randomUUID() };

beforeAll(async () => {
  vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
  await writeDatabase(async (sql) => {
    for (const id of [workspaceId, foreignWorkspaceId])
      await sql.execute("INSERT INTO WORKSPACES (ID,NAME) VALUES (?,?)", [
        id,
        "External MCP integration fixture",
      ]);
    for (const [actor, role] of [
      [owner, "owner"],
      [operator, "operator"],
      [requester, "requester"],
      [foreign, "owner"],
    ] as const)
      await sql.execute(
        "INSERT INTO MEMBERSHIPS (WORKSPACE_ID,USER_ID,NAME,ROLE,ACTIVE,VERSION) VALUES (?,?,?,?,TRUE,1)",
        [actor.workspaceId, actor.userId, `MCP ${role}`, role],
      );
  });
});
afterAll(async () => {
  await writeDatabase(async (sql) => {
    for (const table of [
      "MODEL_ATTEMPTS",
      "AGENT_STEPS",
      "TRIAGE_PROPOSALS",
      "AGENT_RUNS",
      "AGENT_EVENTS",
      "KNOWLEDGE_ENTRIES",
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
function decode<T>(response: unknown): T {
  const content = (response as { content: { type: string; text?: string }[] })
    .content;
  const text = content.find((entry) => entry.type === "text")?.text;
  if (!text) throw new Error("Expected an MCP text result.");
  return JSON.parse(text) as T;
}

it("connects an SDK client to actual scoped records, submits a proposal and requires exact human approval", async () => {
  const source = await createKnowledge(owner, randomUUID(), {
    title: "Onboarding priority",
    kind: "procedure",
    content:
      "New onboarding records should be prioritized for review before joining.",
    dataset: "People",
    ownerId: null,
    effectiveFrom: "2026-01-01",
    effectiveUntil: null,
    supersedesId: null,
  });
  await changeKnowledge(owner, source.id, randomUUID(), 1, "approve");
  const record = await createRequest(requester, randomUUID(), {
    title: "Prepare a joiner",
    businessQuestion: "Prepare onboarding access.",
    reportingPeriod: "Next month",
    dataset: "People",
  });
  const foreignRecord = await createRequest(foreign, randomUUID(), {
    title: "Restricted foreign record",
    businessQuestion: "This workspace is separate.",
    reportingPeriod: "Next month",
    dataset: "People",
  });
  const created = await createAgentConnection(owner, {
    commandId: randomUUID(),
    label: "Codex integration",
    client: "codex",
  });
  const token = created.token!;
  const client = new Client({
    name: "Loom real-database SDK test",
    version: "1.0.0",
  });
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
  try {
    await client.connect(transport);
    const toolList = await client.listTools();
    expect(toolList.tools).toHaveLength(8);
    const workspace = decode<{
      workspace: { id: string };
      tool: PublishedTool;
      knowledgeDigest: string;
    }>(await client.callTool({ name: "loom_get_workspace", arguments: {} }));
    expect(workspace.workspace.id).toBe(workspaceId);
    const listed = decode<{ requests: { id: string }[] }>(
      await client.callTool({ name: "loom_list_requests", arguments: {} }),
    );
    expect(listed.requests.map((entry) => entry.id)).toContain(record.id);
    expect(listed.requests.map((entry) => entry.id)).not.toContain(
      foreignRecord.id,
    );
    expect(
      (
        await client.callTool({
          name: "loom_get_request",
          arguments: { id: foreignRecord.id },
        })
      ).isError,
    ).toBe(true);
    const evidence = decode<{ entries: { entry: { id: string } }[] }>(
      await client.callTool({
        name: "loom_search_knowledge",
        arguments: { q: "onboarding" },
      }),
    );
    expect(evidence.entries.map((match) => match.entry.id)).toEqual([
      source.id,
    ]);
    const input: ExternalProposalInput = {
      commandId: randomUUID(),
      requestId: record.id,
      expectedVersion: record.version,
      toolRevision: workspace.tool.revision,
      knowledgeDigest: workspace.knowledgeDigest,
      summary: "Prioritize this onboarding record for human review.",
      reasons: ["The approved onboarding procedure requests prompt review."],
      uncertainty: [],
      evidenceIds: [source.id],
      commands: [{ type: "set_priority", priority: "high" }],
    };
    const result = decode<{
      runId: string;
      proposalId: string;
      hash: string;
      state: string;
    }>(
      await client.callTool({ name: "loom_propose_changes", arguments: input }),
    );
    expect(result.state).toBe("pending_review");
    const before = await details(owner, record.id);
    expect(before.request).toMatchObject({ version: 1, priority: "normal" });
    const replay = await createExternalProposal(token, input);
    expect(replay).toMatchObject({
      runId: result.runId,
      proposalId: result.proposalId,
      hash: result.hash,
      replayed: true,
    });
    const saved: RunDetails = await readRun(owner, result.runId);
    expect(saved.run).toMatchObject({
      engine: "external-mcp-v1",
      status: "completed",
      model: "external/codex",
    });
    expect(saved.proposals[0].content.inference).toMatchObject({
      promptTokens: null,
      completionTokens: null,
      cost: null,
      durationMs: null,
    });
    expect(JSON.stringify(saved)).not.toContain(token);
    expect((await listRuns(owner)).runs.map((run) => run.id)).toContain(
      result.runId,
    );
    await expect(
      changeRun(
        owner,
        result.runId,
        randomUUID(),
        saved.run.version,
        "advance",
      ),
    ).rejects.toMatchObject({ code: "RUN_TERMINAL" });
    await expect(
      reviewProposal(
        requester,
        result.proposalId,
        randomUUID(),
        result.hash,
        "approve",
      ),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(
      reviewProposal(
        owner,
        result.proposalId,
        randomUUID(),
        "0".repeat(64),
        "approve",
      ),
    ).rejects.toMatchObject({ code: "PROPOSAL_HASH" });
    await reviewProposal(
      operator,
      result.proposalId,
      randomUUID(),
      result.hash,
      "approve",
    );
    expect((await details(owner, record.id)).request).toMatchObject({
      version: 2,
      priority: "high",
    });
    await reviewProposal(
      owner,
      result.proposalId,
      randomUUID(),
      result.hash,
      "approve",
    );
    expect((await details(owner, record.id)).request.version).toBe(2);
    expect(await createExternalProposal(token, input)).toMatchObject({
      proposalId: result.proposalId,
      state: "applied",
      replayed: true,
    });
    const guidance = await createKnowledgeFromProposal(
      owner,
      result.proposalId,
      {
        commandId: randomUUID(),
        hash: result.hash,
        title: "Reviewed onboarding priority",
        body: "Prioritize onboarding records for review before the joining date.",
        rationale: "The human reviewer accepted this explicit priority change.",
        kind: "procedure",
      },
    );
    expect(guidance).toMatchObject({
      state: "draft",
      provenance: { proposalId: result.proposalId },
    });
    const [used] = await readDatabase((sql) =>
      sql.query(
        "SELECT LAST_USED_AT,CLIENT_NAME FROM AGENT_CONNECTIONS WHERE ID=?",
        [created.connection.id],
      ),
    );
    expect(used.LAST_USED_AT).toBeTruthy();
    expect(used.CLIENT_NAME).toBe("Loom real-database SDK test");
  } finally {
    await client.close();
  }
});

it("blocks stale context, command replay conflicts, credential revocation and owner removal without modifying records", async () => {
  const record = await createRequest(requester, randomUUID(), {
    title: "Prepare another joiner",
    businessQuestion: "Check the process.",
    reportingPeriod: "Next month",
    dataset: "People",
  });
  const created = await createAgentConnection(owner, {
    commandId: randomUUID(),
    label: "Claude integration",
    client: "claude-code",
  });
  const token = created.token!;
  const workspace = await externalWorkspace(token);
  const input: ExternalProposalInput = {
    commandId: randomUUID(),
    requestId: record.id,
    expectedVersion: record.version,
    toolRevision: workspace.tool.revision,
    knowledgeDigest: workspace.knowledgeDigest,
    summary: "Review this priority change.",
    reasons: ["The operator requested a review."],
    uncertainty: ["There is no cited procedure."],
    evidenceIds: [],
    commands: [{ type: "set_priority", priority: "high" }],
  };
  await expect(
    createExternalProposal(token, { ...input, expectedVersion: 2 }),
  ).rejects.toMatchObject({ code: "STALE_PROPOSAL" });
  await expect(
    createExternalProposal(token, { ...input, toolRevision: 99 }),
  ).rejects.toMatchObject({ code: "STALE_TOOL" });
  await expect(
    createExternalProposal(token, {
      ...input,
      knowledgeDigest: "0".repeat(64),
    }),
  ).rejects.toMatchObject({ code: "STALE_KNOWLEDGE" });
  await expect(
    createExternalProposal(token, { ...input, evidenceIds: [randomUUID()] }),
  ).rejects.toMatchObject({ code: "AGENT_PROPOSAL_INVALID" });
  const saved = await createExternalProposal(token, input);
  await expect(
    createExternalProposal(token, {
      ...input,
      summary: "Changed command payload",
    }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  await revokeAgentConnection(
    owner,
    created.connection.id,
    randomUUID(),
    created.connection.version,
  );
  await expect(
    createExternalProposal(token, { ...input, commandId: randomUUID() }),
  ).rejects.toMatchObject({ code: "AGENT_UNAUTHORIZED" });
  await expect(
    reviewProposal(
      operator,
      saved.proposalId,
      randomUUID(),
      saved.hash,
      "approve",
    ),
  ).rejects.toMatchObject({ code: "AGENT_UNAUTHORIZED" });
  expect((await details(owner, record.id)).request).toMatchObject({
    version: 1,
    priority: "normal",
  });
  const next = await createAgentConnection(owner, {
    commandId: randomUUID(),
    label: "Removed owner",
    client: "other",
  });
  await writeDatabase((sql) =>
    sql.execute(
      'UPDATE MEMBERSHIPS SET "ROLE"=? WHERE WORKSPACE_ID=? AND USER_ID=?',
      ["requester", owner.workspaceId, owner.userId],
    ),
  );
  try {
    await expect(externalWorkspace(next.token!)).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
  } finally {
    await writeDatabase((sql) =>
      sql.execute(
        'UPDATE MEMBERSHIPS SET "ROLE"=? WHERE WORKSPACE_ID=? AND USER_ID=?',
        ["owner", owner.workspaceId, owner.userId],
      ),
    );
  }
});
