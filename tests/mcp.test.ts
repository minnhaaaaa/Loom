import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { Client } from "../apps/web/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "../apps/web/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";
import { DomainError } from "@loom/domain";

const boundary = vi.hoisted(() => ({
  authenticate: vi.fn(),
  touch: vi.fn(),
  workspace: vi.fn(),
  propose: vi.fn(),
  requests: vi.fn(),
  request: vi.fn(),
  knowledge: vi.fn(),
  tasks: vi.fn(),
  replyTask: vi.fn(),
  proposeTool: vi.fn(),
}));
vi.mock("../apps/web/server/settings", () => ({
  authenticateAgentToken: (...args: unknown[]) =>
    boundary.authenticate(...args),
  touchAgentConnection: (...args: unknown[]) => boundary.touch(...args),
}));
vi.mock("../apps/web/server/external-agent", () => ({
  externalWorkspace: (...args: unknown[]) => boundary.workspace(...args),
  externalRequests: (...args: unknown[]) => boundary.requests(...args),
  externalRequest: (...args: unknown[]) => boundary.request(...args),
  externalKnowledge: (...args: unknown[]) => boundary.knowledge(...args),
  createExternalProposal: (...args: unknown[]) => boundary.propose(...args),
}));
vi.mock("../apps/web/server/external-tasks", () => ({
  listExternalTasks: (...args: unknown[]) => boundary.tasks(...args),
  replyExternalTask: (...args: unknown[]) => boundary.replyTask(...args),
  proposeExternalTool: (...args: unknown[]) => boundary.proposeTool(...args),
}));
import { handleMcpRequest } from "../apps/web/server/mcp";
const token = `loom_agent_${"a".repeat(43)}`;
const url = "http://localhost:3000/api/mcp";
beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
  for (const mock of Object.values(boundary)) mock.mockReset();
  boundary.authenticate.mockResolvedValue({
    actor: { userId: randomUUID(), workspaceId: randomUUID() },
    connection: { id: "connection-id" },
  });
  boundary.touch.mockResolvedValue(undefined);
  boundary.workspace.mockResolvedValue({
    workspace: { id: "test-workspace", name: "Company" },
    knowledgeDigest: "f".repeat(64),
  });
  boundary.propose.mockResolvedValue({
    runId: randomUUID(),
    proposalId: randomUUID(),
    state: "pending_review",
  });
  boundary.tasks.mockResolvedValue({
    tasks: [{ id: "task-id", prompt: "What needs attention?" }],
    hasMore: false,
  });
  boundary.replyTask.mockResolvedValue({
    taskId: "task-id",
    state: "completed",
  });
});
function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
function client() {
  const client = new Client({
    name: "Loom integration test",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: (input, init) => handleMcpRequest(new Request(input, init)),
    reconnectionOptions: {
      initialReconnectionDelay: 1,
      maxReconnectionDelay: 1,
      maxRetries: 0,
      reconnectionDelayGrowFactor: 1,
    },
  });
  return { client, transport };
}

it("uses the official SDK for a real initialize, tool discovery, read and review-only proposal roundtrip", async () => {
  const { client: agent, transport } = client();
  try {
    await agent.connect(transport);
    expect(agent.getServerVersion()?.name).toBe("Loom");
    const tools = await agent.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "loom_list_tasks",
      "loom_get_workspace",
      "loom_list_requests",
      "loom_get_request",
      "loom_search_knowledge",
      "loom_propose_changes",
      "loom_propose_tool",
      "loom_reply_task",
    ]);
    expect(
      tools.tools.some((tool) =>
        /approve|apply|publish|settings/.test(tool.name),
      ),
    ).toBe(false);
    const workspace = await agent.callTool({
      name: "loom_get_workspace",
      arguments: {},
    });
    expect(JSON.stringify(workspace)).toContain("Company");
    expect(boundary.workspace).toHaveBeenCalledWith(token);
    const values = {
      commandId: randomUUID(),
      requestId: randomUUID(),
      expectedVersion: 1,
      toolRevision: 1,
      knowledgeDigest: "f".repeat(64),
      summary: "A proposed priority change",
      reasons: ["A human should inspect this priority."],
      uncertainty: [],
      evidenceIds: [],
      commands: [{ type: "set_priority", priority: "high" }],
    };
    const proposal = await agent.callTool({
      name: "loom_propose_changes",
      arguments: values,
    });
    expect(JSON.stringify(proposal)).toContain("pending_review");
    expect(boundary.propose).toHaveBeenCalledWith(token, values);
    expect(boundary.touch).toHaveBeenCalledWith(
      "connection-id",
      "Loom integration test",
    );
    expect(boundary.authenticate.mock.calls.length).toBeGreaterThanOrEqual(4);
  } finally {
    await agent.close();
  }
});

it("discovers queued prompts and returns an agent reply through real MCP calls without an approval tool", async () => {
  const { client: agent, transport } = client();
  try {
    await agent.connect(transport);
    const tasks = await agent.callTool({
      name: "loom_list_tasks",
      arguments: {},
    });
    expect(JSON.stringify(tasks)).toContain("What needs attention?");
    const input = {
      commandId: randomUUID(),
      taskId: randomUUID(),
      expectedVersion: 1,
      contextHash: "a".repeat(64),
      reply: "Here is what needs attention.",
      evidenceIds: [],
      proposalIds: [],
    };
    const reply = await agent.callTool({
      name: "loom_reply_task",
      arguments: input,
    });
    expect(JSON.stringify(reply)).toContain("completed");
    expect(boundary.replyTask).toHaveBeenCalledWith(token, input);
    const invalid = await agent.callTool({
      name: "loom_reply_task",
      arguments: { ...input, approve: true },
    });
    expect(invalid.isError).toBe(true);
    expect(boundary.replyTask).toHaveBeenCalledTimes(1);
  } finally {
    await agent.close();
  }
});

it("rejects cookies without bearer authorization and rejects foreign origins/hosts before database authentication", async () => {
  const denied: Record<string, string>[] = [
    { Authorization: "", Cookie: "loom_session=a-valid-looking-cookie" },
    { Origin: "https://untrusted.example" },
    { Host: "rogue.example" },
    { Origin: "null" },
  ];
  for (const headers of denied) {
    const response = await handleMcpRequest(
      request({ jsonrpc: "2.0", id: 1, method: "tools/list" }, headers),
    );
    expect([401, 403]).toContain(response.status);
    expect(response.headers.get("cache-control")).toContain("no-store");
  }
  expect(boundary.authenticate).not.toHaveBeenCalled();
});

it("rechecks credentials after discovery and never treats a prior handshake as a session grant", async () => {
  const { client: agent, transport } = client();
  try {
    await agent.connect(transport);
    await agent.listTools();
    boundary.authenticate.mockRejectedValue(
      new DomainError(
        "AGENT_TOKEN_INVALID",
        "This connection was revoked.",
        401,
      ),
    );
    const response = await handleMcpRequest(
      request({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "loom_get_workspace", arguments: {} },
      }),
    );
    expect(response.status).toBe(401);
    expect(boundary.workspace).not.toHaveBeenCalled();
  } finally {
    await agent.close();
  }
});

it("bounds the body and input schema and sanitizes internal tool failures", async () => {
  const oversized = await handleMcpRequest(
    request({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "loom_get_workspace",
        arguments: { junk: "a".repeat(130_000) },
      },
    }),
  );
  expect(oversized.status).toBe(413);
  const { client: agent, transport } = client();
  try {
    await agent.connect(transport);
    const invalid = await agent.callTool({
      name: "loom_get_workspace",
      arguments: { workspaceId: "foreign-workspace" },
    });
    expect(invalid.isError).toBe(true);
    expect(boundary.workspace).not.toHaveBeenCalled();
    boundary.workspace.mockRejectedValue(
      new Error(`private database diagnostic ${token}`),
    );
    const failure = await agent.callTool({
      name: "loom_get_workspace",
      arguments: {},
    });
    expect(failure.isError).toBe(true);
    expect(JSON.stringify(failure)).not.toContain(token);
    expect(JSON.stringify(failure)).toContain("AGENT_OPERATION_FAILED");
  } finally {
    await agent.close();
  }
});
