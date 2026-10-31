import { selectOption } from "../helpers/select";
import { expect, test, type Page } from "@playwright/test";
import type {
  AccountContext,
  RequestRecord,
  ToolSpec,
  ToolWorkspace,
  WorkspaceAccess,
  WorkspaceInvitation,
  WorkspaceSummary,
} from "../../packages/contracts/src/index";

const origin = "http://127.0.0.1:3200";

async function read<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(path);
  expect(response.ok()).toBe(true);
  return response.json() as Promise<T>;
}

async function post<T>(page: Page, path: string, values: object): Promise<T> {
  const response = await page.request.post(path, {
    headers: { Origin: origin },
    data: values,
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<T>;
}

async function openPeopleAccess(page: Page) {
  const access = page.locator("#workspace-access");
  await expect(access).toBeVisible();
  if ((await access.getAttribute("open")) === null)
    await access.locator(":scope > summary").click();
  const controls = access.locator(".workspace-access");
  await expect(controls).toBeVisible();
  return controls;
}

async function openSharing(page: Page) {
  await openPeopleAccess(page);
  const share = page.locator(".workspace-access-share");
  await expect(share).toBeVisible();
  if ((await share.getAttribute("open")) === null)
    await share.locator(":scope > summary").click();
  return share;
}

async function fillIntake(page: Page, spec: ToolSpec, title: string) {
  const panel = page.getByRole("dialog");
  for (const [id, value] of Object.entries({
    title,
    businessQuestion: "How can this synthetic team coordinate its request?",
    reportingPeriod: "October 2026",
    dataset: "Synthetic collaboration events",
  })) {
    const field = spec.fields.find((candidate) => candidate.id === id)!;
    await panel
      .getByRole("textbox", { name: field.label, exact: true })
      .fill(value);
  }
}

test("separate colleague accounts share a published tool, resolve concurrent edits, and obey workspace access changes", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const suffix = crypto.randomUUID().slice(0, 8);
  const ownerName = `Owner ${suffix}`;
  const colleagueName = `Colleague ${suffix}`;
  const workspaceName = `Collaboration ${suffix}`;
  const password = `Synthetic-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const ownerContext = await browser.newContext({ baseURL: origin });
  const colleagueContext = await browser.newContext({ baseURL: origin });
  const outsiderContext = await browser.newContext({ baseURL: origin });
  const owner = await ownerContext.newPage();
  const colleague = await colleagueContext.newPage();
  owner.setDefaultTimeout(15_000);
  colleague.setDefaultTimeout(15_000);

  try {
    await owner.goto("/register");
    const account = owner.locator(".account-access");
    await account
      .getByRole("textbox", { name: "Your name", exact: true })
      .fill(ownerName);
    await account
      .getByRole("textbox", { name: "Company name", exact: true })
      .fill(workspaceName);
    await account
      .getByRole("textbox", { name: "Email address", exact: true })
      .fill(`owner.${suffix}@example.com`);
    await account.getByLabel("Password", { exact: true }).fill(password);
    await account
      .getByRole("button", {
        name: "Create company and account",
        exact: true,
      })
      .click();
    await openPeopleAccess(owner);
    const ownerAccount = await read<AccountContext>(owner, "/api/account");
    expect(ownerAccount.user?.name).toBe(ownerName);
    const primaryId = ownerAccount.currentWorkspaceId!;
    expect(primaryId).toBeTruthy();

    let share = await openSharing(owner);
    await expect(
      share.getByRole("button", {
        name: `Remove access for ${ownerName}`,
        exact: true,
      }),
    ).toBeDisabled();
    await selectOption(
      share.getByRole("combobox", { name: "Invitation role", exact: true }),
      "operator",
    );
    await share
      .getByRole("button", { name: "Create invitation link", exact: true })
      .click();
    const invitationLink = share.getByRole("textbox", {
      name: "Invitation link",
      exact: true,
    });
    await expect(invitationLink).toBeVisible();
    const joinUrl = await invitationLink.inputValue();
    expect(new URL(joinUrl).pathname).toBe("/join");
    expect(new URL(joinUrl).search).toBe("");
    expect(new URL(joinUrl).hash).toMatch(/^#token=.+/);

    await colleague.goto(joinUrl);
    const join = colleague.getByRole("region", {
      name: "Workspace invitation",
      exact: true,
    });
    await expect(
      join.getByRole("heading", { name: `Join ${workspaceName}`, exact: true }),
    ).toBeVisible();
    await join
      .getByRole("textbox", { name: "Your name", exact: true })
      .fill(colleagueName);
    await join
      .getByRole("textbox", { name: "Email address", exact: true })
      .fill(`colleague.${suffix}@example.com`);
    await join.getByLabel("Password", { exact: true }).fill(password);
    await join
      .getByRole("button", {
        name: "Create account and join workspace",
        exact: true,
      })
      .click();
    await expect(
      colleague.getByRole("heading", {
        name: "Data requests",
        exact: true,
      }),
    ).toBeVisible();
    await colleague.goto("/app?view=settings");
    await openPeopleAccess(colleague);
    const colleagueAccount = await read<AccountContext>(
      colleague,
      "/api/account",
    );
    expect(colleagueAccount.user?.id).not.toBe(ownerAccount.user?.id);
    expect(colleagueAccount.currentWorkspaceId).toBe(primaryId);
    expect(colleagueAccount.workspaces).toEqual([
      { id: primaryId, name: workspaceName, role: "operator" },
    ]);
    await colleague
      .getByRole("button", { name: "Sign out", exact: true })
      .click();
    await expect(colleague.locator(".account-access")).toBeVisible();
    await colleague.goto("/login");
    await colleague
      .getByLabel("Email address", { exact: true })
      .fill(`colleague.${suffix}@example.com`);
    await colleague.getByLabel("Password", { exact: true }).fill(password);
    await colleague
      .getByRole("button", { name: "Sign in to company", exact: true })
      .click();
    await expect(
      colleague.getByRole("heading", { name: "Data requests", exact: true }),
    ).toBeVisible();
    expect(
      (await read<AccountContext>(colleague, "/api/account"))
        .currentWorkspaceId,
    ).toBe(primaryId);
    await colleague.goto("/app?view=settings");

    const builder = owner.locator(".tool-builder");
    await builder.locator(":scope > summary").click();
    await builder.getByText("Advanced settings", { exact: true }).click();
    await builder
      .getByRole("button", { name: "IT requests", exact: true })
      .click();
    const toolTitle = `Team requests ${suffix}`;
    await builder
      .getByRole("textbox", { name: "Desk name", exact: true })
      .fill(toolTitle);
    await builder
      .getByRole("button", { name: "Review changes", exact: true })
      .click();
    await builder
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await expect(owner.locator(".current-tool-label")).toContainText(toolTitle);
    await expect(colleague.locator(".current-tool-label")).toContainText(
      toolTitle,
      { timeout: 12_000 },
    );
    await owner.goto("/app?view=records");
    await colleague.goto("/app?view=records");
    await expect(owner.getByRole("heading", { level: 1 })).toHaveText(
      toolTitle,
    );
    await expect(colleague.getByRole("heading", { level: 1 })).toHaveText(
      toolTitle,
    );
    const published = (await read<ToolWorkspace>(owner, "/api/tool")).published;
    expect(
      (await read<ToolWorkspace>(colleague, "/api/tool")).published,
    ).toEqual(published);

    const requestTitle = `Shared request ${suffix}`;
    await colleague
      .getByRole("button", { name: "New request", exact: true })
      .click();
    await fillIntake(colleague, published.spec, requestTitle);
    const createdResponse = colleague.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/requests" &&
        response.request().method() === "POST",
    );
    await colleague
      .getByRole("dialog")
      .getByRole("button", { name: "Create request", exact: true })
      .click();
    const created = await createdResponse;
    expect(created.ok()).toBe(true);
    const request = (await created.json()) as RequestRecord;
    await expect(colleague.getByRole("dialog")).toHaveCount(0);
    await expect(
      owner.getByRole("button", { name: requestTitle, exact: true }),
    ).toBeVisible({ timeout: 12_000 });
    await owner
      .getByRole("button", { name: requestTitle, exact: true })
      .click();
    await colleague
      .getByRole("button", { name: requestTitle, exact: true })
      .click();
    const ownerPanel = owner.getByRole("dialog");
    const colleaguePanel = colleague.getByRole("dialog");
    const questionLabel = published.spec.fields.find(
      (field) => field.id === "businessQuestion",
    )!.label;
    const colleagueDraft = `Colleague draft ${suffix}`;
    await colleaguePanel
      .getByRole("textbox", { name: questionLabel, exact: true })
      .fill(colleagueDraft);
    await ownerPanel
      .getByRole("textbox", { name: questionLabel, exact: true })
      .fill(`Owner update ${suffix}`);
    await ownerPanel
      .getByRole("button", { name: "Save description", exact: true })
      .click();
    await expect(
      colleaguePanel.getByRole("alert", {
        name: "Request edit conflict",
        exact: true,
      }),
    ).toBeVisible({ timeout: 12_000 });
    await expect(
      colleaguePanel.getByRole("textbox", { name: questionLabel, exact: true }),
    ).toHaveValue(colleagueDraft);
    await expect(
      colleaguePanel.getByRole("button", {
        name: "Save description",
        exact: true,
      }),
    ).toBeDisabled();
    await colleaguePanel
      .getByRole("button", {
        name: "Keep my draft with current version",
        exact: true,
      })
      .click();
    await colleaguePanel
      .getByRole("button", { name: "Save description", exact: true })
      .click();
    await expect(
      ownerPanel.getByRole("textbox", { name: questionLabel, exact: true }),
    ).toHaveValue(colleagueDraft, { timeout: 12_000 });

    const commentDraft = `Colleague comment ${suffix}`;
    await colleaguePanel
      .getByRole("textbox", { name: "Add a comment", exact: true })
      .fill(commentDraft);
    const ownerComment = `Owner conversation update ${suffix}`;
    await ownerPanel
      .getByRole("textbox", { name: "Add a comment", exact: true })
      .fill(ownerComment);
    await ownerPanel
      .getByRole("button", { name: "Add comment", exact: true })
      .click();
    await expect(
      colleaguePanel.getByText(ownerComment, { exact: true }),
    ).toBeVisible({ timeout: 12_000 });
    await expect(
      colleaguePanel.getByRole("textbox", {
        name: "Add a comment",
        exact: true,
      }),
    ).toHaveValue(commentDraft);
    await colleaguePanel
      .getByRole("button", { name: "Add comment", exact: true })
      .click();
    await expect(
      ownerPanel.getByText(commentDraft, { exact: true }),
    ).toBeVisible({ timeout: 12_000 });
    await ownerPanel
      .getByRole("button", { name: "Close request panel", exact: true })
      .click();
    await colleaguePanel
      .getByRole("button", { name: "Close request panel", exact: true })
      .click();

    const ownerOnlyTitle = `Owner request ${suffix}`;
    const ownerRequest = await post<RequestRecord>(owner, "/api/requests", {
      commandId: crypto.randomUUID(),
      expectedToolRevision: published.revision,
      values: {
        title: ownerOnlyTitle,
        businessQuestion: "Synthetic request owned by the workspace creator.",
      },
    });
    await owner.goto("/app?view=insights");
    await expect(owner.getByRole("heading", { level: 1 })).toHaveText(
      "Flow insights",
    );
    await expect(
      owner.getByRole("heading", { name: "Time in each stage", exact: true }),
    ).toBeVisible();
    await expect(
      owner.getByText("Calculated in Exasol", { exact: true }),
    ).toBeVisible();
    await selectOption(
      owner.getByRole("combobox", { name: /Reporting period/ }),
      "90",
    );
    await expect(
      owner.getByRole("table", { name: /Weekly request flow/ }),
    ).toBeVisible();
    await colleague.goto("/app?view=insights");
    await expect(
      colleague.getByRole("heading", {
        name: "Time in each stage",
        exact: true,
      }),
    ).toBeVisible();
    await colleague.goto("/app?view=records");
    const otherName = `Separate workspace ${suffix}`;
    await owner.goto("/app?view=settings");
    const workspaceControls = await openPeopleAccess(owner);
    await workspaceControls
      .locator(".workspace-access-create > summary")
      .click();
    await workspaceControls
      .getByRole("textbox", { name: "New workspace name", exact: true })
      .fill(otherName);
    const workspaceResponse = owner.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/workspaces" &&
        response.request().method() === "POST",
    );
    await workspaceControls
      .getByRole("button", { name: "Create workspace", exact: true })
      .click();
    expect((await workspaceResponse).ok()).toBe(true);
    // Switching workspaces remounts Settings with its access section closed.
    await expect(
      owner.getByRole("combobox", {
        name: "Current workspace",
        exact: true,
        includeHidden: true,
      }),
    ).not.toHaveAttribute("data-value", primaryId);
    await openPeopleAccess(owner);
    const changedAccount = await read<AccountContext>(owner, "/api/account");
    const otherWorkspace = changedAccount.workspaces.find(
      (workspace) => workspace.id === changedAccount.currentWorkspaceId,
    )! as WorkspaceSummary;
    expect(otherWorkspace.name).toBe(otherName);
    await expect(
      owner.getByRole("combobox", { name: "Current workspace", exact: true }),
    ).toHaveAttribute("data-value", otherWorkspace.id);
    const otherTool = (await read<ToolWorkspace>(owner, "/api/tool")).published;
    const isolated = await post<RequestRecord>(owner, "/api/requests", {
      commandId: crypto.randomUUID(),
      expectedToolRevision: otherTool.revision,
      values: {
        title: `Isolated request ${suffix}`,
        businessQuestion: "Synthetic content in a separate workspace.",
      },
    });
    expect(
      (await read<AccountContext>(colleague, "/api/account")).workspaces.some(
        (workspace) => workspace.id === otherWorkspace.id,
      ),
    ).toBe(false);
    expect(
      (await colleague.request.get(`/api/requests/${isolated.id}`)).status(),
    ).toBe(404);
    const guessedLinkResponse = colleague.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/workspaces/select" &&
        response.request().method() === "POST",
    );
    await colleague.goto(`/w/${otherWorkspace.id}`);
    expect((await guessedLinkResponse).status()).toBe(403);
    await expect(colleague.locator("main .alert[role=alert]")).toBeVisible();
    expect(
      (await read<AccountContext>(colleague, "/api/account"))
        .currentWorkspaceId,
    ).toBe(primaryId);
    await expect(
      colleague.getByText(`Isolated request ${suffix}`, { exact: true }),
    ).toHaveCount(0);
    await colleague.goto("/app?view=records");

    const outsider = await outsiderContext.newPage();
    await outsider.goto(`/w/${otherWorkspace.id}`);
    await expect(outsider.locator(".account-access")).toBeVisible();
    expect(
      (await read<AccountContext>(outsider, "/api/account")).user,
    ).toBeNull();
    expect([401, 403]).toContain(
      (
        await outsider.request.post("/api/workspaces/select", {
          headers: { Origin: origin },
          data: { workspaceId: otherWorkspace.id },
        })
      ).status(),
    );
    await expect(
      outsider.getByText(`Isolated request ${suffix}`, { exact: true }),
    ).toHaveCount(0);

    // A durable link returns the authorized owner to the intended workspace.
    await owner.goto(`/w/${primaryId}`);
    await expect(owner).toHaveURL(`${origin}/app`);
    expect(
      (await read<AccountContext>(owner, "/api/account")).currentWorkspaceId,
    ).toBe(primaryId);
    // The dashboard keeps the last view; open Requests to verify this tool.
    await owner
      .getByRole("navigation", { name: "Main", exact: true })
      .getByRole("link", { name: "Requests", exact: true })
      .click();
    await expect(owner.getByRole("heading", { level: 1 })).toHaveText(
      toolTitle,
    );
    await owner.goto("/app?view=settings");
    await openPeopleAccess(owner);
    await expect(
      owner.getByRole("combobox", { name: "Current workspace", exact: true }),
    ).toHaveAttribute("data-value", primaryId);

    share = await openSharing(owner);
    await selectOption(
      share.getByRole("combobox", {
        name: `Role for ${colleagueName}`,
        exact: true,
      }),
      "requester",
    );
    await share
      .getByRole("button", {
        name: `Save role for ${colleagueName}`,
        exact: true,
      })
      .click();
    await expect
      .poll(
        async () =>
          (
            await read<WorkspaceAccess>(owner, "/api/workspaces/access")
          ).members.find(
            (member) => member.userId === colleagueAccount.user?.id,
          )?.role,
      )
      .toBe("requester");
    expect((await colleague.request.get("/api/insights")).status()).toBe(403);
    await expect(
      colleague.getByRole("button", { name: requestTitle, exact: true }),
    ).toBeVisible({ timeout: 12_000 });
    await expect(
      colleague.getByRole("button", { name: ownerOnlyTitle, exact: true }),
    ).toHaveCount(0, { timeout: 12_000 });
    expect(
      (
        await colleague.request.get(`/api/requests/${ownerRequest.id}`)
      ).status(),
    ).toBe(404);
    const ownDetail = await read<{ request: RequestRecord }>(
      colleague,
      `/api/requests/${request.id}`,
    );
    expect(ownDetail.request.requesterId).toBe(colleagueAccount.user?.id);
    expect(ownDetail.request).not.toHaveProperty("priority");
    expect(
      (
        await colleague.request.post(`/api/requests/${request.id}/commands`, {
          headers: { Origin: origin },
          data: {
            commandId: crypto.randomUUID(),
            expectedVersion: ownDetail.request.version,
            expectedToolRevision: published.revision,
            command: { type: "set_priority", priority: "high" },
          },
        })
      ).status(),
    ).toBe(403);

    share = await openSharing(owner);
    await share
      .getByRole("button", {
        name: `Remove access for ${colleagueName}`,
        exact: true,
      })
      .click();
    await expect
      .poll(async () =>
        [401, 403].includes(
          (await colleague.request.get("/api/desk")).status(),
        ),
      )
      .toBe(true);
    await expect(
      colleague.getByRole("button", { name: requestTitle, exact: true }),
    ).toHaveCount(0, { timeout: 12_000 });
    expect([401, 403, 404]).toContain(
      (await colleague.request.get(`/api/requests/${request.id}`)).status(),
    );

    share = await openSharing(owner);
    await selectOption(
      share.getByRole("combobox", { name: "Invitation role", exact: true }),
      "viewer",
    );
    const revokedResponse = owner.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/workspaces/invitations" &&
        response.request().method() === "POST",
    );
    await share
      .getByRole("button", { name: "Create invitation link", exact: true })
      .click();
    const revokedInvitation = (await (
      await revokedResponse
    ).json()) as WorkspaceInvitation;
    const revokedUrl = await share
      .getByRole("textbox", { name: "Invitation link", exact: true })
      .inputValue();
    await share
      .getByRole("button", {
        name: `Revoke invitation ${revokedInvitation.id}`,
        exact: true,
      })
      .click();
    await expect(
      share.getByRole("textbox", { name: "Invitation link", exact: true }),
    ).toHaveCount(0);
    await colleague.goto(revokedUrl);
    await expect(
      colleague.getByRole("heading", {
        name: "Invitation unavailable",
        exact: true,
      }),
    ).toBeVisible();
    await expect(colleague.locator("main .alert[role=alert]")).toBeVisible();
    await expect(
      colleague.getByRole("button", {
        name: "Create account and join workspace",
        exact: true,
      }),
    ).toHaveCount(0);
    await owner.screenshot({
      path: "test-results/connected-workspace-sharing.png",
      fullPage: true,
    });
  } finally {
    // Keep only this uniquely named synthetic workspace/account history; no direct DB writers run alongside the app.
    await ownerContext.close();
    await colleagueContext.close();
    await outsiderContext.close();
  }
});
