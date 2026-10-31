import { expect, test } from "@playwright/test";

test("the assistant view is one prompt instead of knowledge and triage forms", async ({
  page,
}) => {
  await page.goto("/app?view=assistant");
  const assistant = page.getByRole("region", {
    name: "Workspace assistant",
    exact: true,
  });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "What would you like to do?",
  );
  await expect(
    assistant.getByRole("textbox", { name: "Ask your workspace", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(1);
  await expect(
    assistant.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByLabel("Knowledge content", { exact: true }),
  ).not.toBeVisible();
  await expect(
    page.getByText("Run triage and review proposals", { exact: true }),
  ).not.toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("table")).toHaveCount(0);
  await page.screenshot({
    path: "test-results/prompt-workspace-desktop.png",
    fullPage: true,
  });
});

test("the single prompt fits a narrow screen without exposing administrative controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app?view=assistant");
  await expect(
    page.getByRole("textbox", { name: "Ask your workspace", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByLabel("Knowledge content", { exact: true }),
  ).not.toBeVisible();
  await page.screenshot({
    path: "test-results/prompt-workspace-mobile.png",
    fullPage: true,
  });
  await page
    .getByRole("combobox", { name: "Workspace view", exact: true })
    .selectOption("settings");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Workspace settings",
  );
  await page
    .getByRole("combobox", { name: "Workspace view", exact: true })
    .selectOption("assistant");
  await expect(
    page.getByRole("textbox", { name: "Ask your workspace", exact: true }),
  ).toBeVisible();
});

test("navigation keeps the prompt, saved work, and settings in separate views", async ({
  page,
}) => {
  await page.goto("/app?view=assistant");
  await page
    .getByRole("link", { name: "Workspace settings", exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Workspace settings",
  );
  await expect(
    page.getByRole("textbox", { name: "Ask your workspace", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: /^Data requests/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Data requests",
  );
  await expect(page.getByRole("table")).toBeVisible();
  await page
    .getByRole("link", { name: "Ask your assistant", exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "What would you like to do?",
  );
  await expect(page.getByRole("textbox")).toHaveCount(1);
  await expect(page.getByRole("table")).toHaveCount(0);
});
