import { expect, test, type Page } from "@playwright/test";
import type {
  AgentConnection,
  CreatedAgentConnection,
  PublishedTool,
  RequestRecord,
  ToolDraft,
  ToolSpec,
  WorkspaceSettings,
} from "../../packages/contracts/src/index";

const origin = "http://127.0.0.1:3200";
async function post<T>(page: Page, path: string, body: object): Promise<T> {
  const response = await page.request.post(path, {
    headers: { Origin: origin },
    data: body,
  });
  expect(response.ok(), `${path}: ${response.status()}`).toBe(true);
  return response.json() as Promise<T>;
}
async function rpc(page: Page, token: string, method: string, params: object) {
  const response = await page.request.post("/api/mcp", {
    headers: {
      Origin: origin,
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
    data: { jsonrpc: "2.0", id: 1, method, params },
  });
  expect(response.ok()).toBe(true);
  return response.json();
}
async function tool<T>(page: Page, token: string, name: string, args: object) {
  const envelope = await rpc(page, token, "tools/call", {
    name,
    arguments: args,
  });
  expect(envelope.error).toBeUndefined();
  expect(envelope.result.isError).not.toBe(true);
  return JSON.parse(envelope.result.content[0].text) as T;
}
type Task = {
  id: string;
  prompt: string;
  version: number;
  contextHash: string;
  context: {
    tool: PublishedTool;
    records: RequestRecord[];
    knowledgeDigest: string;
  };
};
async function sendPrompt(page: Page, token: string, prompt: string) {
  await page
    .getByRole("textbox", { name: "Ask your workspace", exact: true })
    .fill(prompt);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByText("Request saved. Waiting for a response.", { exact: true }),
  ).toBeVisible();
  const inbox = await tool<{ tasks: Task[] }>(
    page,
    token,
    "loom_list_tasks",
    {},
  );
  const task = inbox.tasks.find((item) => item.prompt === prompt);
  expect(task).toBeTruthy();
  return task!;
}

test("one prompt delivers real external replies, reviewed record changes, and an owner tool draft", async ({
  page,
}) => {
  test.setTimeout(150_000);
  page.setDefaultTimeout(15_000);
  const suffix = crypto.randomUUID().slice(0, 8);
  await post(page, "/api/account/register", {
    name: "Prompt admin",
    email: `prompt.${suffix}@example.com`,
    password: `Synthetic-${crypto.randomUUID()}`,
    workspaceName: `Prompt team ${suffix}`,
  });
  const settings = (await (
    await page.request.get("/api/workspaces/settings")
  ).json()) as WorkspaceSettings;
  await post(page, "/api/workspaces/settings", {
    commandId: crypto.randomUUID(),
    expectedVersion: settings.version,
    branding: {
      ...settings.branding,
      companyName: `Prompt team ${suffix}`,
      primaryColor: "#3832a0",
    },
    preferredAgent: "codex",
    completeSetup: true,
  });
  const issued = await post<CreatedAgentConnection>(
    page,
    "/api/workspaces/agents",
    {
      commandId: crypto.randomUUID(),
      label: "Prompt journey client",
      client: "codex",
    },
  );
  const token = issued.token!;
  try {
    const hello = await rpc(page, token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "Prompt browser protocol fixture", version: "1" },
    });
    expect(hello.result.serverInfo.name).toBe("Loom");
    const record = await post<RequestRecord>(page, "/api/requests", {
      commandId: crypto.randomUUID(),
      values: {
        title: `Joiner access ${suffix}`,
        businessQuestion: "Prepare a colleague's access.",
      },
    });
    await page.goto("/app?view=assistant");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "What would you like to do?",
    );
    await expect(page.getByRole("textbox")).toHaveCount(1);
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(
      page.getByText("Team knowledge", { exact: true }),
    ).not.toBeVisible();
    await expect(page.locator(".app-shell")).toHaveCSS(
      "--brand-primary",
      "#3832a0",
    );

    const question = await sendPrompt(
      page,
      token,
      "What is the team currently working on?",
    );
    const answer = `Your team has an access request: Joiner access ${suffix}.`;
    await tool(page, token, "loom_reply_task", {
      commandId: crypto.randomUUID(),
      taskId: question.id,
      expectedVersion: question.version,
      contextHash: question.contextHash,
      reply: answer,
      evidenceIds: [],
      proposalIds: [],
    });
    await expect(page.getByText(answer, { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText(answer, { exact: true })).toBeVisible();

    const change = await sendPrompt(
      page,
      token,
      `Suggest raising the priority of Joiner access ${suffix}.`,
    );
    const proposal = await tool<{ proposalId: string; hash: string }>(
      page,
      token,
      "loom_propose_changes",
      {
        commandId: crypto.randomUUID(),
        taskId: change.id,
        requestId: record.id,
        expectedVersion: record.version,
        toolRevision: change.context.tool.revision,
        knowledgeDigest: change.context.knowledgeDigest,
        summary: "Raise the access request's priority for review.",
        reasons: ["The owner asked to review this priority change."],
        uncertainty: ["No policy evidence was provided."],
        evidenceIds: [],
        commands: [{ type: "set_priority", priority: "high" }],
      },
    );
    await tool(page, token, "loom_reply_task", {
      commandId: crypto.randomUUID(),
      taskId: change.id,
      expectedVersion: change.version,
      contextHash: change.contextHash,
      reply: "I prepared a priority change for your review.",
      evidenceIds: [],
      proposalIds: [proposal.proposalId],
    });
    const approve = page.getByRole("button", {
      name: `Approve and apply changes to ${record.title}`,
      exact: true,
    });
    await expect(approve).toBeDisabled();
    expect(
      (await (await page.request.get(`/api/requests/${record.id}`)).json())
        .request.priority,
    ).toBe("normal");
    await page
      .getByRole("checkbox", {
        name: "I reviewed these proposed changes.",
        exact: true,
      })
      .check();
    await approve.click();
    await expect(
      page.getByText("Approved changes applied to the workspace.", {
        exact: true,
      }),
    ).toBeVisible();
    expect(
      (await (await page.request.get(`/api/requests/${record.id}`)).json())
        .request.priority,
    ).toBe("high");

    const create = await sendPrompt(
      page,
      token,
      "Adapt this tool for employee onboarding, with a department field.",
    );
    const spec: ToolSpec = {
      ...create.context.tool.spec,
      title: `People onboarding ${suffix}`,
      fields: [
        ...create.context.tool.spec.fields,
        {
          id: "custom_department",
          label: "Department",
          type: "text",
          requiredAt: "optional",
          maxLength: 200,
          visible: true,
        },
      ],
    };
    const prepared = await tool<{ version: number; toolDraft: ToolDraft }>(
      page,
      token,
      "loom_propose_tool",
      {
        commandId: crypto.randomUUID(),
        taskId: create.id,
        expectedTaskVersion: create.version,
        contextHash: create.contextHash,
        expectedRevision: create.context.tool.revision,
        spec,
      },
    );
    await tool(page, token, "loom_reply_task", {
      commandId: crypto.randomUUID(),
      taskId: create.id,
      expectedVersion: prepared.version,
      contextHash: create.contextHash,
      reply:
        "I prepared the onboarding tool with an optional Department field.",
      evidenceIds: [],
      proposalIds: [],
    });
    const draft = page.getByRole("article", {
      name: `Draft tool: ${spec.title}`,
      exact: true,
    });
    await expect(draft).toBeVisible();
    await expect(draft.getByText("Department", { exact: true })).toBeVisible();
    expect(
      (await (await page.request.get("/api/tool")).json()).published.revision,
    ).toBe(create.context.tool.revision);
    const publish = draft.getByRole("button", {
      name: "Publish shared tool",
      exact: true,
    });
    await expect(publish).toBeDisabled();
    await draft
      .getByRole("checkbox", {
        name: "I reviewed this tool and its changes.",
        exact: true,
      })
      .check();
    await publish.click();
    await expect(
      page.getByText("Your shared tool is published.", { exact: true }),
    ).toBeVisible();
    const published = (await (await page.request.get("/api/tool")).json())
      .published as PublishedTool;
    expect(published.spec.title).toBe(spec.title);
    expect(
      published.spec.fields.find((field) => field.id === "custom_department")
        ?.label,
    ).toBe("Department");
    expect(
      (await (await page.request.get(`/api/requests/${record.id}`)).json())
        .request.priority,
    ).toBe("high");
    await page.reload();
    await expect(page.getByText(answer, { exact: true })).toBeVisible();
  } finally {
    const connections = (await (
      await page.request.get("/api/workspaces/agents")
    ).json()) as { connections: AgentConnection[] };
    const connection = connections.connections.find(
      (item) => item.id === issued.connection.id,
    );
    if (connection && !connection.revokedAt)
      await post(page, `/api/workspaces/agents/${connection.id}/revoke`, {
        commandId: crypto.randomUUID(),
        expectedVersion: connection.version,
      });
  }
});
