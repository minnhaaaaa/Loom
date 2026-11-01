import { expect, test, type Page } from "@playwright/test";
import { selectOption } from "../helpers/select";
import type { SourceSnapshot } from "@loom/contracts";
const origin = "http://127.0.0.1:3200";
async function account(page: Page) {
  const id = crypto.randomUUID();
  const response = await page.request.post("/api/account/register", {
    headers: { Origin: origin },
    data: {
      name: "Source UI fixture",
      email: `sources.${id}@example.com`,
      password: `Synthetic-${id}`,
      workspaceName: "Source UI test",
    },
  });
  expect(response.ok()).toBe(true);
}
function initial(): SourceSnapshot {
  return {
    microsoftAvailable: true,
    syncEnabled: true,
    connections: [],
    sources: [],
  };
}
test("owners connect Slack and explicitly choose an intake channel before automatic imports", async ({
  page,
}) => {
  let snapshot = initial(),
    selected = false;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/workspaces/sources", async (route) => {
    expect(route.request().headers()["x-loom-workspace"]).toBeTruthy();
    if (route.request().method() === "GET")
      return route.fulfill({ json: snapshot });
    const input = route.request().postDataJSON();
    if (input.action === "connect-slack") {
      expect(input.token).toBe("xoxb-synthetic-ui-token");
      snapshot = {
        ...snapshot,
        connections: [{ provider: "slack", name: "Example team", version: 1 }],
      };
    } else if (input.action === "browse")
      return route.fulfill({
        json: { options: [{ id: "CINTAKE", name: "analytics-intake" }] },
      });
    else if (input.action === "select") {
      expect(input.selection).toEqual({
        provider: "slack",
        rootId: "CINTAKE",
        parentId: "",
        shareWithWorkspace: true,
        requestMode: "detect",
      });
      selected = true;
      snapshot = {
        ...snapshot,
        sources: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            provider: "slack",
            name: "#analytics-intake",
            active: true,
            lastSyncedAt: null,
            nextSyncAt: new Date().toISOString(),
            error: null,
            imported: 0,
            skipped: 0,
            syncing: false,
            requestMode: "detect",
            reviewCount: 0,
            review: [],
            issues: [],
          },
        ],
      };
    } else if (input.action === "pause")
      snapshot = {
        ...snapshot,
        sources: snapshot.sources.map((source) => ({
          ...source,
          active: false,
        })),
      };
    else throw new Error(`Unexpected fixture action ${input.action}`);
    await route.fulfill({ json: snapshot });
  });
  await account(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/app?view=settings");
  const panel = page.locator("#connected-sources");
  await panel
    .getByRole("button", { name: "Connect Slack", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "I already have a token" }).click();
  await dialog.getByLabel("User OAuth token").fill("xoxb-synthetic-ui-token");
  await dialog.getByRole("button", { name: "Verify connection" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Slack connected" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Choose source" }).click();
  await selectOption(
    dialog.getByRole("combobox", { name: "Channel", exact: true }),
    "CINTAKE",
  );
  await dialog.getByRole("button", { name: "Review import" }).click();
  await expect(
    dialog.getByRole("button", { name: "Start automatic import" }),
  ).toBeDisabled();
  expect(selected).toBe(false);
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Start automatic import" }).click();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    panel.getByText("#analytics-intake", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("Waiting for first sync", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: "test-results-connected/sources-desktop.png",
    fullPage: true,
  });
  await panel.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(panel.getByText("Paused", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
test("Microsoft device sign-in shows a code without claiming an account is connected", async ({
  page,
}) => {
  await page.route("**/api/workspaces/sources", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: initial() });
    const input = route.request().postDataJSON();
    if (input.action === "connect-microsoft")
      return route.fulfill({
        json: {
          id: "11111111-1111-4111-8111-111111111111",
          userCode: "ABCD-EFGH",
          verificationUri: "https://microsoft.com/devicelogin",
          expiresAt: new Date(Date.now() + 900000).toISOString(),
          interval: 5,
        },
      });
    return route.fulfill({ json: { connected: false } });
  });
  await account(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app?view=settings");
  const panel = page.locator("#connected-sources");
  await panel
    .getByRole("button", { name: "Connect Microsoft Teams", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await page
    .context()
    .route("https://microsoft.com/devicelogin", (route) =>
      route.fulfill({ body: "Synthetic Microsoft sign-in page" }),
    );
  const popupPromise = page.waitForEvent("popup");
  await dialog.getByRole("button", { name: "Sign in with Microsoft" }).click();
  const popup = await popupPromise;
  await popup.waitForURL("https://microsoft.com/devicelogin");
  await expect(dialog.getByText("ABCD-EFGH", { exact: true })).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "Continue to Microsoft" }),
  ).toHaveAttribute("href", "https://microsoft.com/devicelogin");
  await expect(
    panel.getByRole("button", { name: "Manage Microsoft Teams" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    animations: "disabled",
    path: "test-results-connected/sources-mobile.png",
    fullPage: true,
  });
});
test("SharePoint library selection shares references only after explicit source consent", async ({
  page,
}) => {
  const snapshot = initial();
  snapshot.connections = [
    { provider: "microsoft", name: "Example Microsoft", version: 1 },
  ];
  let selection: unknown;
  await page.route("**/api/workspaces/sources", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: snapshot });
    const input = route.request().postDataJSON();
    if (input.action === "browse")
      return route.fulfill({
        json: {
          options: input.parentId
            ? [{ id: "DRIVE", name: "Metric definitions" }]
            : [{ id: "SITE", name: "Analytics" }],
        },
      });
    if (input.action === "select") selection = input.selection;
    await route.fulfill({ json: snapshot });
  });
  await account(page);
  await page.goto("/app?view=settings");
  const panel = page.locator("#connected-sources");
  await panel.getByRole("button", { name: "Manage SharePoint" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Choose source" }).click();
  await dialog.getByLabel("Find a site", { exact: true }).fill("Analytics");
  await dialog.getByRole("button", { name: "Find sites", exact: true }).click();
  await selectOption(
    dialog.getByRole("combobox", { name: "Site", exact: true }),
    "SITE",
  );
  await selectOption(
    dialog.getByRole("combobox", { name: "Document library", exact: true }),
    "DRIVE",
  );
  await dialog.getByRole("button", { name: "Review import" }).click();
  await dialog.getByRole("checkbox").check();
  await panel
    .getByRole("button", { name: "Start automatic import", exact: true })
    .click();
  await expect(
    dialog.getByRole("heading", { name: "Import queued" }),
  ).toBeVisible();
  expect(selection).toEqual({
    provider: "sharepoint",
    parentId: "SITE",
    rootId: "DRIVE",
    shareWithWorkspace: true,
    requestMode: "detect",
  });
});

test("general-chat review stays compact and supports importing or dismissing a candidate", async ({
  page,
}) => {
  const sourceId = "11111111-1111-4111-8111-111111111111";
  let snapshot: SourceSnapshot = {
    ...initial(),
    connections: [{ provider: "slack", name: "Example team", version: 1 }],
    sources: [
      {
        id: sourceId,
        provider: "slack",
        name: "#general",
        active: true,
        lastSyncedAt: new Date().toISOString(),
        nextSyncAt: new Date().toISOString(),
        error: null,
        imported: 1,
        skipped: 0,
        syncing: false,
        requestMode: "detect",
        reviewCount: 2,
        issues: [],
        review: [
          {
            externalId: "1.1",
            hash: "a".repeat(64),
            title: "Why did revenue drop?",
            text: "Why did revenue drop?",
            url: "https://fixture.slack.com/archives/GENERAL/p1",
            reason: "Possible request",
          },
          {
            externalId: "1.2",
            hash: "b".repeat(64),
            title: "Which metric should we use?",
            text: "Which metric should we use?",
            url: "https://fixture.slack.com/archives/GENERAL/p2",
            reason: "Possible request",
          },
        ],
      },
    ],
  };
  const decisions: string[] = [];
  await page.route("**/api/workspaces/sources", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: snapshot });
    const input = route.request().postDataJSON();
    if (input.action === "review") {
      expect(input.id).toBe(sourceId);
      expect(input.hash).toBe(
        input.externalId === "1.1" ? "a".repeat(64) : "b".repeat(64),
      );
      decisions.push(input.decision);
      snapshot = {
        ...snapshot,
        sources: snapshot.sources.map((source) => ({
          ...source,
          reviewCount: source.reviewCount - 1,
          imported: source.imported + (input.decision === "accept" ? 1 : 0),
          review: source.review.filter(
            (candidate) => candidate.externalId !== input.externalId,
          ),
        })),
      };
    } else throw new Error("Unexpected review fixture action");
    return route.fulfill({ json: snapshot });
  });
  await account(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/app?view=settings");
  const panel = page.locator("#connected-sources");
  await expect(
    panel.getByText("Why did revenue drop?", { exact: true }).first(),
  ).toBeHidden();
  await panel.getByText("Review 2 possible requests", { exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Import request", exact: true }),
  ).toHaveCount(2);
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({
    animations: "disabled",
    path: "test-results-connected/request-review-desktop.png",
  });
  await panel
    .getByRole("button", { name: "Import request", exact: true })
    .first()
    .click();
  await expect(
    panel.getByText("Request imported.", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await panel
    .getByText("Review 1 possible request", { exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    animations: "disabled",
    path: "test-results-connected/request-review-mobile.png",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await panel.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(
    panel.getByText("Message dismissed.", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText(/Review \d possible/)).toHaveCount(0);
  expect(decisions).toEqual(["accept", "dismiss"]);
});

test("GitHub setup explains code import, recovers from errors, and keeps selection explicit", async ({
  page,
}) => {
  let snapshot = initial(),
    fail = true;
  let selection: unknown;
  await page.route("**/api/workspaces/sources", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: snapshot });
    const input = route.request().postDataJSON();
    if (input.action === "connect-github") {
      if (fail) {
        fail = false;
        return route.fulfill({
          status: 422,
          json: {
            error: {
              code: "SOURCE_ACCESS",
              message: "Token needs organization approval.",
            },
          },
        });
      }
      snapshot = {
        ...snapshot,
        connections: [
          { provider: "github", name: "fixture-admin", version: 1 },
        ],
      };
      return route.fulfill({ json: snapshot });
    }
    if (input.action === "browse")
      return route.fulfill({
        json: { options: [{ id: "123", name: "fixture/analytics" }] },
      });
    if (input.action === "select") {
      selection = input.selection;
      return route.fulfill({ json: snapshot });
    }
    throw new Error(`Unexpected action ${input.action}`);
  });
  await account(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/app?view=settings");
  const trigger = page.getByRole("button", {
    name: "Connect GitHub",
    exact: true,
  });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Choose your repositories" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "Open GitHub" }),
  ).toHaveAttribute("target", "_blank");
  await page.screenshot({
    animations: "disabled",
    path: "test-results-connected/github-guide-desktop.png",
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await dialog.getByRole("button", { name: "Next step" }).click();
  await expect(
    dialog.getByText("Contents · Read-only", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Next step" }).click();
  await dialog
    .getByLabel("Fine-grained token")
    .fill("github_pat_synthetic_ui_token");
  await dialog.getByRole("button", { name: "Verify connection" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "organization approval",
  );
  await dialog.getByRole("button", { name: "Verify connection" }).click();
  await expect(
    dialog.getByRole("heading", { name: "GitHub connected" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Choose source" }).click();
  await selectOption(
    dialog.getByRole("combobox", { name: "Repository", exact: true }),
    "123",
  );
  await dialog.getByRole("button", { name: "Answer", exact: true }).click();
  await expect(
    dialog.getByText("Revenue excludes refunds. [revenue.sql]", {
      exact: true,
    }),
  ).toBeVisible();
  expect(selection).toBeUndefined();
  await page.screenshot({
    animations: "disabled",
    path: "test-results-connected/github-choose-desktop.png",
  });
  await dialog.getByRole("button", { name: "Review import" }).click();
  await expect(dialog.getByText(/Default-branch code/)).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Start automatic import" }),
  ).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    animations: "disabled",
    path: "test-results-connected/github-review-mobile.png",
  });
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Start automatic import" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Import queued" }),
  ).toBeVisible();
  expect(selection).toMatchObject({
    provider: "github",
    rootId: "123",
    parentId: "",
    shareWithWorkspace: true,
  });
});

test("Discord walks through bot setup and selects only a chosen server and channel", async ({
  page,
}) => {
  let snapshot = initial();
  let selection: unknown;
  await page.route("**/api/workspaces/sources", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: snapshot });
    const input = route.request().postDataJSON();
    if (input.action === "connect-discord")
      snapshot = {
        ...snapshot,
        connections: [{ provider: "discord", name: "Loom bot", version: 1 }],
      };
    if (input.action === "browse")
      return route.fulfill({
        json: {
          options: input.parentId
            ? [{ id: "123456789012345678", name: "#analytics" }]
            : [{ id: "223456789012345678", name: "Analytics team" }],
        },
      });
    if (input.action === "select") selection = input.selection;
    return route.fulfill({ json: snapshot });
  });
  await account(page);
  await page.goto("/app?view=settings");
  await page.getByRole("button", { name: "Connect Discord" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("Message Content Intent · On", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "I already have a token" }).click();
  await dialog.getByLabel("Bot token").fill("synthetic_discord_token");
  await dialog.getByRole("button", { name: "Verify connection" }).click();
  await dialog.getByRole("button", { name: "Choose source" }).click();
  await selectOption(
    dialog.getByRole("combobox", { name: "Server", exact: true }),
    "223456789012345678",
  );
  await selectOption(
    dialog.getByRole("combobox", { name: "Channel", exact: true }),
    "123456789012345678",
  );
  await dialog.getByRole("button", { name: "Review import" }).click();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Start automatic import" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Import queued" }),
  ).toBeVisible();
  expect(selection).toMatchObject({
    provider: "discord",
    parentId: "223456789012345678",
    rootId: "123456789012345678",
    requestMode: "detect",
    shareWithWorkspace: true,
  });
});
