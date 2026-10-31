import { expect, test, type Page } from "@playwright/test";
import { selectOption } from "../helpers/select";

const origin = "http://127.0.0.1:3200";
async function createWorkspace(page: Page) {
  const suffix = crypto.randomUUID();
  const response = await page.request.post("/api/account/register", {
    headers: { Origin: origin },
    data: {
      name: "Model picker test",
      email: `${suffix}@example.com`,
      password: `Synthetic-${suffix}`,
      workspaceName: "Picker workspace",
    },
  });
  expect(response.ok()).toBe(true);
  await page.goto("/app?view=settings");
}

test("company model choices use the selected provider, keep the theme, and send the chosen ID only on save", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let listCalls = 0,
    saveCalls = 0;
  await page.route("**/api/workspaces/provider/models", async (route) => {
    listCalls++;
    expect(route.request().postDataJSON()).toEqual({
      provider: "openai",
      apiKey: "synthetic-picker-api-key",
    });
    await route.fulfill({
      json: {
        models: [
          { id: "model-small", name: "Small" },
          { id: "model-large", name: "Large" },
        ],
      },
    });
  });
  await page.route("**/api/workspaces/provider", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    saveCalls++;
    const input = route.request().postDataJSON();
    expect(input.model).toBe("model-large");
    expect(input.acknowledgeCharges).toBe(true);
    await route.fulfill({
      json: {
        available: true,
        message: "",
        version: 1,
        active: true,
        provider: "openai",
        model: input.model,
        maxTokens: 4096,
        testedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
  });
  await createWorkspace(page);
  await page.getByText("Company AI connection", { exact: true }).click();
  const settings = page.locator(".company-provider");
  await expect(
    settings.getByText(
      /Your team uses Loom normally|Test and save sends one small request/,
    ),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("combobox", { name: "Model ID", exact: true }),
  ).toBeDisabled();
  await settings
    .locator('input[type="password"]')
    .fill("synthetic-picker-api-key");
  await settings
    .getByRole("button", { name: "Load models", exact: true })
    .click();
  const picker = settings.getByRole("combobox", {
    name: "Model ID",
    exact: true,
  });
  await expect(picker).toBeEnabled();
  await picker.click();
  const popup = page.locator(".loom-select-popup");
  await expect(popup).toHaveCSS("background-color", "rgb(25, 24, 27)");
  await expect(
    popup.getByRole("option", { name: "Large · model-large", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results-connected/model-picker-desktop.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(picker).toBeFocused();
  await selectOption(picker, "model-large");
  expect(listCalls).toBe(1);
  expect(saveCalls).toBe(0);
  await settings.getByRole("checkbox").check();
  await settings
    .getByRole("button", { name: "Test and save connection", exact: true })
    .click();
  await expect(settings.locator(".provider-state")).toHaveText("Connected");
  expect(saveCalls).toBe(1);
  await selectOption(
    settings.getByRole("combobox", { name: "Provider", exact: true }),
    "deepseek",
  );
  await expect(picker).toHaveText("Load models to choose");
  await expect(picker).toBeDisabled();
  await expect(settings.locator('input[type="password"]')).toHaveValue("");
  expect(errors).toEqual([]);
});

test("ChatGPT models use account choices in the same mobile dropdown", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let saves = 0;
  const connection = {
    configured: true,
    status: "plan_enabled",
    inferenceAvailable: true,
    canonicalOrigin: origin,
    clientId: "synthetic-client",
    accounts: [],
    model: null,
    identity: {
      email: "picker@example.com",
      name: "Picker",
      verifiedAt: new Date().toISOString(),
    },
    message: "",
  };
  await page.route("**/api/workspaces/codex", async (route) => {
    if (route.request().method() === "PATCH") {
      saves++;
      expect(route.request().postDataJSON()).toEqual({ model: "plan-model-b" });
      return route.fulfill({ json: { ...connection, model: "plan-model-b" } });
    }
    return route.fulfill({ json: connection });
  });
  await page.route("**/api/workspaces/codex/models", (route) =>
    route.fulfill({
      json: {
        models: [
          { id: "plan-model-a", name: "Plan Alpha" },
          { id: "plan-model-b", name: "Plan Beta" },
        ],
      },
    }),
  );
  await createWorkspace(page);
  const setup = page.locator("#company-setup");
  if ((await setup.getAttribute("open")) === null)
    await setup.locator(":scope > summary").click();
  await setup
    .getByLabel("Company name", { exact: true })
    .fill("Picker workspace");
  await setup.getByRole("button", { name: "Continue", exact: true }).click();
  await setup.getByRole("button", { name: "Continue", exact: true }).click();
  await setup
    .getByRole("button", { name: /Codex Connect with your ChatGPT account/ })
    .click();
  await page.getByRole("button", { name: "Got it", exact: true }).click();
  const picker = setup.getByRole("combobox", {
    name: "ChatGPT model ID",
    exact: true,
  });
  await picker.click();
  await expect(
    page.getByRole("option", { name: "Plan Beta", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results-connected/model-picker-mobile.png",
    fullPage: true,
  });
  await page.keyboard.press("b");
  await page.keyboard.press("Escape");
  await selectOption(picker, "plan-model-b");
  expect(saves).toBe(0);
  await setup
    .getByRole("button", { name: "Save ChatGPT model", exact: true })
    .click();
  await expect(picker).toHaveText("Plan Beta");
  expect(saves).toBe(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("request-dialog dropdowns stay above the dialog and support keyboard selection", async ({
  page,
}) => {
  await createWorkspace(page);
  const tool = (await (await page.request.get("/api/tool")).json()).published;
  const title = `Dropdown request ${crypto.randomUUID().slice(0, 8)}`;
  const created = await page.request.post("/api/requests", {
    headers: { Origin: origin },
    data: {
      commandId: crypto.randomUUID(),
      expectedToolRevision: tool.revision,
      values: {
        title,
        businessQuestion: "Synthetic dropdown check",
        reportingPeriod: "October 2026",
        dataset: "Synthetic",
      },
    },
  });
  expect(created.ok()).toBe(true);
  await page.goto("/app?view=records");
  await page.getByRole("button", { name: title, exact: true }).click();
  const dialog = page.getByRole("dialog");
  const owner = dialog.getByRole("combobox", { name: "Owner", exact: true });
  await owner.focus();
  await page.keyboard.press("ArrowDown");
  const menu = dialog.locator(".loom-select-popup");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(menu).not.toBeVisible();
  await expect(owner).toBeFocused();
  await owner.focus();
  await page.keyboard.press("ArrowDown");
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole("option", { name: "Unassigned", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    menu.getByRole("option", { name: "Model picker test", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(owner).toHaveText("Model picker test");
  await expect(menu).not.toBeVisible();
  await expect(owner).toBeEnabled();
  await expect(dialog).toBeVisible();
  await dialog.screenshot({
    path: "test-results-connected/request-dropdown.png",
  });
});
