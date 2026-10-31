import { expect, test, type Page } from "@playwright/test";
import type {
  KnowledgeEntry,
  WorkspaceInvitation,
  TeamMemorySnapshot,
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

test("a team publishes an onboarding tool, shares it with a requester, and explores approved memory", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const suffix = crypto.randomUUID().slice(0, 8);
  const password = `Synthetic-${crypto.randomUUID()}`;
  await post(page, "/api/account/register", {
    name: `People lead ${suffix}`,
    email: `people.${suffix}@example.com`,
    password,
    workspaceName: `Onboarding ${suffix}`,
  });
  await page.goto("/app?view=settings");
  const builder = page.locator(".tool-builder");
  await builder.getByText("Customize this desk", { exact: true }).click();
  await builder.getByText("Advanced settings", { exact: true }).click();
  await builder
    .getByRole("button", { name: "Employee onboarding", exact: true })
    .click();
  await builder
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await builder
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  await expect(page.locator(".current-tool-label")).toContainText(
    "Employee onboarding",
  );
  await page.locator("#workspace-access > summary").click();
  await page.locator(".workspace-access-share > summary").click();
  await expect(page.locator(".workspace-access-share")).toHaveAttribute(
    "open",
    "",
  );

  const source = await post<KnowledgeEntry>(page, "/api/knowledge", {
    commandId: crypto.randomUUID(),
    values: {
      title: `Onboarding procedure ${suffix}`,
      kind: "procedure",
      content:
        "Before a joiner starts, confirm their team and joining date. Record equipment progress in the onboarding tasks field.",
      dataset: "People",
      ownerId: null,
      effectiveFrom: "2026-01-01",
      effectiveUntil: null,
      supersedesId: null,
    },
  });
  const memoryResponse = await page.request.get("/api/memory");
  expect(memoryResponse.ok()).toBe(true);
  expect(
    ((await memoryResponse.json()) as TeamMemorySnapshot).entries,
  ).toHaveLength(0);
  await post(page, `/api/knowledge/${source.id}`, {
    commandId: crypto.randomUUID(),
    expectedVersion: source.version,
    action: "approve",
  });

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
      name: `Requester ${suffix}`,
      email: `joiner.${suffix}@example.com`,
      password,
    });
    await colleague.goto("/app?view=records");
    await expect(colleague.getByRole("heading", { level: 1 })).toHaveText(
      "Employee onboarding",
    );
    expect((await colleague.request.get("/api/memory")).status()).toBe(403);
    await expect(colleague.locator("#team-memory")).toHaveCount(0);
    await colleague
      .getByRole("button", { name: "New request", exact: true })
      .click();
    const form = colleague.getByRole("dialog");
    await form
      .getByLabel("Employee name", { exact: true })
      .fill(`New joiner ${suffix}`);
    await form
      .getByLabel("Onboarding plan", { exact: true })
      .fill("Prepare access and equipment.");
    await form
      .getByLabel("Joining date", { exact: true })
      .fill("2 November 2026");
    await form.getByLabel("Team or department", { exact: true }).fill("People");
    await form.getByLabel("Assigned buddy", { exact: true }).fill("Priya");
    await form
      .getByLabel("Onboarding tasks and progress", { exact: true })
      .fill("Laptop: awaiting approval");
    await form
      .getByRole("button", { name: "Create request", exact: true })
      .click();
    await expect(form).not.toBeVisible();
    await colleague.reload();
    await expect(
      colleague.getByRole("button", {
        name: `New joiner ${suffix}`,
        exact: true,
      }),
    ).toBeVisible();

    await page.reload();
    await page
      .getByRole("navigation", { name: "Main", exact: true })
      .getByRole("link", { name: "Knowledge", exact: true })
      .click();
    const memory = page.locator("#team-memory");
    await memory
      .getByRole("textbox", { name: "Search team knowledge", exact: true })
      .fill(suffix);
    await expect(
      memory.getByRole("button", { name: "Search", exact: true }),
    ).toBeEnabled();
    await memory.getByRole("button", { name: "Search", exact: true }).click();
    await expect(
      memory.getByRole("heading", { name: source.title, exact: true }),
    ).toBeVisible();
    await memory.getByRole("button", { name: "Graph", exact: true }).click();
    await memory.getByLabel("Explore a saved item").click();
    await page
      .getByRole("option", {
        name: `Request · New joiner ${suffix}`,
        exact: true,
      })
      .click();
    await expect(
      memory
        .locator(".knowledge-graph-relation")
        .filter({ hasText: "Requested by" }),
    ).toBeVisible();
    await memory.getByRole("button", { name: "Timeline", exact: true }).click();
    await expect(
      memory.getByText("knowledge approved", { exact: true }),
    ).toBeVisible();
    await expect(
      memory.getByText("tool published", { exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results-connected/onboarding-team-memory.png",
      fullPage: true,
    });
    await page.getByText("Manage knowledge", { exact: true }).click();
    await page.locator(".agent-run-details > summary").click();
    await expect(page.locator(".agent-run-details")).toHaveAttribute(
      "open",
      "",
    );
    await page
      .getByRole("button", { name: "Find missing details", exact: true })
      .click();
    await expect(
      page.getByLabel("Instructions for the model", { exact: true }),
    ).toHaveValue(/missing information/);
    // Real provider inference is verified separately; this journey stops before any model call.
  } finally {
    await colleagueContext.close();
  }
});
