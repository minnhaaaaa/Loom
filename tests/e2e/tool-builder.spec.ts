import { selectOption } from "../helpers/select";
import { expect, test } from "@playwright/test";

test("customization starts with a desk name and collapsed controls, preserving edits when reopened", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/app?demo=1&view=settings");
  const builder = page.locator(".tool-builder");
  await builder.getByText("Customize this desk", { exact: true }).click();
  await expect(builder.getByLabel("Desk name", { exact: true })).toBeVisible();
  for (const label of [
    "Add a field",
    "Table columns",
    "Advanced settings",
    "Ask AI",
    "Preview",
  ])
    await expect(
      builder.locator("summary").filter({ hasText: new RegExp(`^${label}$`) }),
    ).toBeVisible();
  await expect(
    builder.getByLabel("New field label", { exact: true }),
  ).not.toBeVisible();
  await expect(
    builder.getByLabel("Tool description", { exact: true }),
  ).not.toBeVisible();
  await expect(
    builder.getByLabel("Describe your tool or the changes you want", {
      exact: true,
    }),
  ).not.toBeVisible();
  await expect(
    builder.getByRole("button", { name: "IT requests", exact: true }),
  ).not.toBeVisible();
  await expect(
    builder.getByRole("region", { name: "Review tool changes", exact: true }),
  ).toHaveCount(0);
  await expect(
    builder.getByRole("button", { name: "Apply changes", exact: true }),
  ).toHaveCount(0);
  await expect(builder.locator(".tool-simple-field[open]")).toHaveCount(0);
  await page.screenshot({
    path: "test-results/simple-tool-builder.png",
    fullPage: true,
  });

  const titleField = builder
    .locator(".tool-simple-field")
    .filter({ has: page.getByLabel("Field label: title", { exact: true }) });
  await titleField.locator(":scope > summary").click();
  await titleField
    .getByLabel("Field label: title", { exact: true })
    .fill("Analytics request");
  await titleField.locator(":scope > summary").click();
  await builder.getByText("Table columns", { exact: true }).click();
  const priority = builder.getByRole("checkbox", {
    name: "Priority",
    exact: true,
  });
  await expect(priority).toBeChecked();
  await priority.uncheck();
  await builder.getByText("Table columns", { exact: true }).click();
  await builder.getByLabel("Desk name", { exact: true }).fill("Analytics desk");
  await builder.getByText("Customize this desk", { exact: true }).click();
  await builder.getByText("Customize this desk", { exact: true }).click();
  await expect(builder.getByLabel("Desk name", { exact: true })).toHaveValue(
    "Analytics desk",
  );
  await titleField.locator(":scope > summary").click();
  await expect(
    titleField.getByLabel("Field label: title", { exact: true }),
  ).toHaveValue("Analytics request");
  await builder.getByText("Table columns", { exact: true }).click();
  await expect(priority).not.toBeChecked();
  await builder.getByText("Preview", { exact: true }).click();
  await expect(
    builder.getByLabel("Preview: Analytics request", { exact: true }),
  ).toBeVisible();
  const table = builder.getByRole("table");
  await expect(
    table.getByRole("columnheader", { name: "Analytics request", exact: true }),
  ).toBeVisible();
  await expect(
    table.getByRole("columnheader", { name: "Priority", exact: true }),
  ).toHaveCount(0);
  await expect(table.locator("tbody tr")).toHaveCount(0);
  await expect(
    builder.getByRole("button", { name: "Review changes", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".current-tool-label")).toContainText(
    "Data requests",
  );
  expect(errors).toEqual([]);
});

test("templates preserve fields and the preview contains layout without sample records", async ({
  page,
}) => {
  await page.goto("/app?demo=1");
  await page
    .getByRole("navigation", { name: "Main", exact: true })
    .getByRole("link", { name: "Settings", exact: true })
    .click();
  const builder = page.locator(".tool-builder");
  await builder.getByText("Customize this desk", { exact: true }).click();
  await builder.getByText("Advanced settings", { exact: true }).click();
  await builder
    .getByRole("button", { name: "Employee onboarding", exact: true })
    .click();
  await builder.getByText("Preview", { exact: true }).click();
  await expect(
    builder.getByLabel("Preview: Employee name", { exact: true }),
  ).toBeVisible();
  await expect(
    builder.getByLabel("Preview: Assigned buddy", { exact: true }),
  ).toBeVisible();
  await builder.getByText("Ask AI", { exact: true }).click();
  await expect(
    builder.getByLabel("Describe your tool or the changes you want", {
      exact: true,
    }),
  ).toHaveValue(/onboarding/i);
  const table = builder.getByRole("table");
  await expect(
    table.getByRole("columnheader", { name: "Employee name", exact: true }),
  ).toBeVisible();
  await expect(table.getByRole("row")).toHaveCount(1);
  await expect(table.locator("tbody tr")).toHaveCount(0);
  await expect(builder.getByText("Aarav Shah", { exact: true })).toHaveCount(0);
  await expect(
    builder.getByRole("region", { name: "Queue summary", exact: true }),
  ).toHaveCount(0);
  await expect(builder.getByText("Layout only", { exact: true })).toBeVisible();
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
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings");
  await expect(page.locator(".current-tool-label")).toContainText(
    "Data requests",
  );
});

test("preview builder adds an optional long-text field without changing the published desk", async ({
  page,
}) => {
  await page.goto("/app?demo=1&view=settings");
  const builder = page.locator(".tool-builder");
  await builder.getByText("Customize this desk", { exact: true }).click();
  await builder.getByText("Advanced settings", { exact: true }).click();
  await builder
    .getByRole("button", { name: "IT requests", exact: true })
    .click();
  await builder.getByText("Add a field", { exact: true }).click();
  await builder
    .getByLabel("New field label", { exact: true })
    .fill("Escalation notes");
  await selectOption(
    builder.getByRole("combobox", { name: "Answer format", exact: true }),
    "textarea",
  );
  await builder.getByRole("button", { name: "Add field", exact: true }).click();
  const field = builder.locator(".tool-simple-field").filter({
    has: page.getByLabel("Requirement: Escalation notes", { exact: true }),
  });
  await field.locator(":scope > summary").click();
  await expect(
    field.getByLabel("Requirement: Escalation notes", { exact: true }),
  ).toHaveText("Optional");
  await builder.getByText("Preview", { exact: true }).click();
  await expect(
    builder.getByLabel("Preview: System or service", { exact: true }),
  ).toBeVisible();
  await expect(
    builder.getByLabel("Preview: System or service", { exact: true }),
  ).toBeDisabled();
  await expect(
    builder.getByLabel("Preview: Escalation notes", { exact: true }),
  ).toBeVisible();
  await expect(
    builder.getByLabel("Preview: Escalation notes", { exact: true }),
  ).toBeDisabled();
  await builder.getByText("Ask AI", { exact: true }).click();
  await builder
    .getByLabel("Describe your tool or the changes you want", { exact: true })
    .fill("Make a support desk with an optional escalation note.");
  for (const name of ["Generate a draft", "Review changes"])
    await expect(
      builder.getByRole("button", { name, exact: true }),
    ).toBeDisabled();
  await expect(
    builder.getByRole("button", { name: "Apply changes", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".current-tool-label")).toContainText(
    "Data requests",
  );
});

test("expanded preview customization fits a narrow viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app?demo=1&view=settings");
  const builder = page.locator(".tool-builder");
  await builder.getByText("Customize this desk", { exact: true }).click();
  await builder.getByText("Advanced settings", { exact: true }).click();
  await builder
    .getByRole("button", { name: "IT requests", exact: true })
    .click();
  await builder.getByText("Preview", { exact: true }).click();
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
