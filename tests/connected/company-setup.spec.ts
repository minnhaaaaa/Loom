import { expect, test, type Page } from "@playwright/test";
import type {
  WorkspaceInvitation,
  WorkspaceSettings,
  RunDetails,
  RequestRecord,
  AgentConnection,
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
async function rpc(
  page: Page,
  token: string,
  method: string,
  params: object,
  id = 1,
) {
  return page.request.post("/api/mcp", {
    headers: {
      Origin: origin,
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
    data: { jsonrpc: "2.0", id, method, params },
  });
}
async function tool<T>(
  page: Page,
  token: string,
  name: string,
  args: object,
): Promise<T> {
  const response = await rpc(page, token, "tools/call", {
    name,
    arguments: args,
  });
  expect(response.ok()).toBe(true);
  const envelope = await response.json();
  expect(envelope.error).toBeUndefined();
  expect(envelope.result.isError).not.toBe(true);
  return JSON.parse(envelope.result.content[0].text) as T;
}

test("admin onboarding persists company branding, connects a real MCP client, and reviews its proposal", async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  page.setDefaultTimeout(15_000);
  const suffix = crypto.randomUUID().slice(0, 8);
  const company = `Nimbus ${suffix}`;
  const password = `Synthetic-${crypto.randomUUID()}`;
  await post(page, "/api/account/register", {
    name: "Brand admin",
    email: `brand.${suffix}@example.com`,
    password,
    workspaceName: company,
  });
  await page.goto("/?view=settings");
  const setup = page.locator("#company-setup");
  await expect(setup).toHaveAttribute("open", "");
  await setup.getByLabel("Company name", { exact: true }).fill(company);
  // A genuine PNG is decoded and normalized in the browser before saving.
  await setup
    .getByLabel("Company logo", { exact: true })
    .setInputFiles("tests/fixtures/brand-logo.png");
  await expect(
    setup.getByRole("button", { name: "Remove company logo", exact: true }),
  ).toBeVisible();
  await setup.getByRole("button", { name: "Continue", exact: true }).click();
  await setup.getByRole("button", { name: "Indigo", exact: true }).click();
  await setup.getByLabel("Typography", { exact: true }).selectOption("classic");
  await setup
    .getByLabel("Corner style", { exact: true })
    .selectOption("square");
  await setup.screenshot({
    path: "test-results-connected/company-branding-desktop.png",
  });
  await setup.getByRole("button", { name: "Continue", exact: true }).click();
  await setup.getByRole("button", { name: /Codex Bring the agent/ }).click();
  const connectionName = `Codex admin ${suffix}`;
  await setup
    .getByLabel("Connection name", { exact: true })
    .fill(connectionName);
  await setup
    .getByRole("button", { name: "Create agent connection", exact: true })
    .click();
  const tokenField = setup.getByLabel("New agent access token", {
    exact: true,
  });
  await expect(tokenField).toHaveAttribute("type", "password");
  const token = await tokenField.inputValue();
  expect(token).toMatch(/^loom_agent_/);
  const issued = (
    await (await page.request.get("/api/workspaces/agents")).json()
  ).connections.find(
    (entry: AgentConnection) => entry.label === connectionName,
  ) as AgentConnection;
  try {
    const handshake = await rpc(page, token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "Loom browser protocol fixture", version: "1" },
    });
    expect(handshake.ok()).toBe(true);
    expect((await handshake.json()).result.serverInfo.name).toBe("Loom");
    const workspace = await tool<{
      tool: { revision: number };
      knowledgeDigest: string;
      capabilities: string[];
    }>(page, token, "loom_get_workspace", {});
    expect(workspace.capabilities).toContain(
      "propose_changes_for_human_review",
    );
    const discovery = await rpc(page, token, "tools/list", {});
    expect(
      (await discovery.json()).result.tools.map(
        (entry: { name: string }) => entry.name,
      ),
    ).toEqual(
      expect.arrayContaining(["loom_get_workspace", "loom_propose_changes"]),
    );
    await setup
      .getByRole("button", { name: "Refresh agent status", exact: true })
      .click();
    await expect(setup.getByText(/Last used/)).toBeVisible();
    await setup.getByRole("button", { name: "Continue", exact: true }).click();
    await setup
      .getByRole("button", { name: "Finish company setup", exact: true })
      .click();
    await expect(setup.getByText(/Company setup complete/)).toBeVisible();
    const settingsResponse = await page.request.get("/api/workspaces/settings");
    const settings = (await settingsResponse.json()) as WorkspaceSettings;
    expect(settings.branding).toMatchObject({
      companyName: company,
      primaryColor: "#3832a0",
      font: "classic",
      corners: "square",
    });
    expect(settings.branding.logoDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(settings.setupCompletedAt).toBeTruthy();
    expect(JSON.stringify(settings)).not.toContain(token);
    await page.reload();
    await expect(page.locator(".app-shell")).toHaveCSS(
      "--brand-primary",
      "#3832a0",
    );
    await expect(
      page.getByRole("link", { name: `${company} home`, exact: true }),
    ).toBeVisible();
    await expect(setup).not.toHaveAttribute("open", "");
    await expect(
      page.getByLabel("New agent access token", { exact: true }),
    ).toHaveCount(0);

    const record = await post<RequestRecord>(page, "/api/requests", {
      commandId: crypto.randomUUID(),
      values: {
        title: `External proposal ${suffix}`,
        businessQuestion: "Verify external proposals require a human reviewer.",
      },
    });
    const proposal = await tool<{
      runId: string;
      proposalId: string;
      hash: string;
    }>(page, token, "loom_propose_changes", {
      commandId: crypto.randomUUID(),
      requestId: record.id,
      expectedVersion: record.version,
      toolRevision: workspace.tool.revision,
      knowledgeDigest: workspace.knowledgeDigest,
      summary: "Request human review of this synthetic priority change.",
      reasons: ["The admin requested this synthetic protocol check."],
      uncertainty: ["No policy evidence is available; a human must review."],
      evidenceIds: [],
      commands: [{ type: "set_priority", priority: "high" }],
    });
    expect(
      (
        (await (await page.request.get(`/api/requests/${record.id}`)).json())
          .request as RequestRecord
      ).priority,
    ).toBe("normal");
    await page.locator(".advanced-administration > summary").click();
    await page.locator(".agent-run-details > summary").click();
    await page
      .getByRole("button", { name: "Refresh agent proposals", exact: true })
      .click();
    await page
      .getByRole("combobox", {
        name: "Recent runs (workspace latest 10)",
        exact: true,
      })
      .selectOption(proposal.runId);
    const review = page.locator(".proposal-review");
    await expect(
      review.getByText("Submitted by", { exact: false }),
    ).toBeVisible();
    await review
      .getByRole("checkbox", {
        name: "I reviewed these exact changes and evidence.",
        exact: true,
      })
      .check();
    await review
      .getByRole("button", {
        name: `Approve changes: ${record.title}`,
        exact: true,
      })
      .click();
    await expect(
      page.getByText("Reviewed changes saved atomically.", { exact: true }),
    ).toBeVisible();
    const applied = (await (
      await page.request.get(`/api/runs/${proposal.runId}`)
    ).json()) as RunDetails;
    expect(applied.proposals[0].state).toBe("applied");

    const invitation = await post<WorkspaceInvitation & { token: string }>(
      page,
      "/api/workspaces/invitations",
      { commandId: crypto.randomUUID(), role: "requester" },
    );
    const colleagueContext = await browser.newContext({ baseURL: origin });
    try {
      const colleague = await colleagueContext.newPage();
      await post(colleague, "/api/invitations/accept", {
        token: invitation.token,
        name: "Brand colleague",
        email: `brand.member.${suffix}@example.com`,
        password,
      });
      await colleague.goto("/?view=records");
      await expect(
        colleague.getByRole("link", { name: `${company} home`, exact: true }),
      ).toBeVisible();
      await expect(colleague.locator(".app-shell")).toHaveCSS(
        "--brand-primary",
        "#3832a0",
      );
      await expect(colleague.locator("#company-setup")).toHaveCount(0);
      expect(
        (await colleague.request.get("/api/workspaces/agents")).status(),
      ).toBe(403);
      const forged = await colleague.request.post("/api/workspaces/settings", {
        headers: { Origin: origin },
        data: {
          commandId: crypto.randomUUID(),
          expectedVersion: settings.version,
          branding: settings.branding,
          preferredAgent: "later",
          completeSetup: false,
        },
      });
      expect(forged.status()).toBe(403);
    } finally {
      await colleagueContext.close();
    }
    await page.locator("#company-setup > summary").click();
    await setup
      .getByRole("button", { name: "Your agent", exact: true })
      .click();
    await setup
      .getByRole("button", { name: `Revoke ${connectionName}`, exact: true })
      .click();
    await expect(
      setup.getByText(
        "Agent connection revoked. This token can no longer access the workspace.",
        { exact: true },
      ),
    ).toBeVisible();
    expect((await rpc(page, token, "tools/list", {})).status()).toBe(401);
  } finally {
    // A failed browser assertion must not leave a usable synthetic credential in traces.
    const saved = await page.request
      .get("/api/workspaces/agents")
      .catch(() => null);
    if (saved?.ok()) {
      const current = (await saved.json()).connections.find(
        (entry: AgentConnection) => entry.id === issued.id,
      ) as AgentConnection | undefined;
      if (current && !current.revokedAt)
        await page.request
          .post(`/api/workspaces/agents/${current.id}/revoke`, {
            headers: { Origin: origin },
            data: {
              commandId: crypto.randomUUID(),
              expectedVersion: current.version,
            },
          })
          .catch(() => undefined);
    }
  }
});
