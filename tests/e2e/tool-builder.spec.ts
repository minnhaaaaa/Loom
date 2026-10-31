import { expect, test } from "@playwright/test";

test("workspace settings opens an onboarding draft and preserves its fields across templates", async ({
  page,
}) => {
  await page.goto("/app");
  await page
    .getByRole("link", { name: "Workspace settings", exact: true })
    .click();
  const builder = page.locator(".tool-builder");
  await builder.getByText("Explore the tool builder", { exact: true }).click();
  await builder
    .getByRole("button", { name: "Employee onboarding", exact: true })
    .click();
  await expect(
    builder.getByLabel("Preview: Employee name", { exact: true }),
  ).toBeVisible();
  await expect(
    builder.getByLabel("Preview: Assigned buddy", { exact: true }),
  ).toBeVisible();
  await expect(
    builder.getByLabel("Describe your tool or the changes you want", {
      exact: true,
    }),
  ).toHaveValue(/onboarding/i);
  await expect(builder.getByRole("table")).toContainText("Aarav Shah");
  await builder
    .getByRole("button", { name: "Project reviews", exact: true })
    .click();
  await expect(
    builder.getByLabel("Preview: Assigned buddy", { exact: true }),
  ).toBeVisible();
  await expect(
    builder.getByLabel("Preview: Review brief and decision needed", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Workspace settings",
  );
  await expect(page.locator(".current-tool-label")).toContainText(
    "Data requests",
  );
});

test("sample builder previews an IT template and an optional field without changing the published desk", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/app?view=settings");
  const builder = page.locator(".tool-builder");
  await builder.getByText("Explore the tool builder", { exact: true }).click();
  await builder
    .getByRole("button", { name: "IT requests", exact: true })
    .click();

  await expect(
    builder.getByRole("heading", { name: "IT requests", exact: true }),
  ).toBeVisible();
  await expect(
    builder.getByLabel("Preview: System or service", { exact: true }),
  ).toBeVisible();
  await expect(
    builder.getByLabel("Preview: System or service", { exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".current-tool-label")).toContainText(
    "Data requests",
  );

  await builder
    .getByLabel("New field label", { exact: true })
    .fill("Escalation notes");
  await builder
    .locator(".tool-builder-add-field")
    .getByRole("combobox")
    .selectOption("textarea");
  await builder.getByRole("button", { name: "Add field", exact: true }).click();
  await expect(
    builder.getByLabel("Requirement: Escalation notes", { exact: true }),
  ).toHaveValue("optional");
  await expect(
    builder.getByLabel("Preview: Escalation notes", { exact: true }),
  ).toBeVisible();
  await expect(
    builder.getByLabel("Preview: Escalation notes", { exact: true }),
  ).toBeDisabled();

  await builder
    .getByLabel("Describe your tool or the changes you want", { exact: true })
    .fill("Make a support desk with an optional escalation note.");
  for (const name of [
    "Generate a draft",
    "Save draft for review",
    "Publish reviewed tool",
  ]) {
    await expect(
      builder.getByRole("button", { name, exact: true }),
    ).toBeDisabled();
  }
  await expect(
    builder.getByText(/Unsaved preview · Explore templates/),
  ).toBeVisible();
  await expect(page.locator(".current-tool-label")).toContainText(
    "Data requests",
  );
  expect(errors).toEqual([]);
});

test("expanded sample builder fits a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app?view=settings");
  const builder = page.locator(".tool-builder");
  await builder.getByText("Explore the tool builder", { exact: true }).click();
  await builder
    .getByRole("button", { name: "IT requests", exact: true })
    .click();
  await expect(
    builder.getByLabel("Preview: System or service", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/mobile-tool-builder.png",
    fullPage: true,
  });
});
