import { expect, test } from "@playwright/test";

test("company setup previews brand colors, typography and identity without saving sample state", async ({
  page,
}) => {
  await page.goto("/app");
  await page.getByRole("link", { name: "Company setup", exact: true }).click();
  const setup = page.locator("#company-setup");
  await setup.getByLabel("Company name", { exact: true }).fill("Nimbus");
  await expect(
    page.getByRole("link", { name: "Nimbus home", exact: true }),
  ).toBeVisible();
  await setup.getByRole("button", { name: "Continue", exact: true }).click();
  await setup.getByRole("button", { name: "Indigo", exact: true }).click();
  await expect(page.locator(".app-shell")).toHaveCSS(
    "--brand-primary",
    "#3832a0",
  );
  await setup.getByLabel("Typography", { exact: true }).selectOption("classic");
  await setup
    .getByLabel("Corner style", { exact: true })
    .selectOption("square");
  await expect(page.locator(".app-shell")).toHaveCSS(
    "--brand-control-radius",
    "2px",
  );
  await setup
    .getByRole("textbox", { name: "Primary color hex", exact: true })
    .fill("red");
  await expect(
    setup.getByRole("button", { name: "Continue", exact: true }),
  ).toBeDisabled();
  await expect(setup.getByText(/Use six-digit hex colors/)).toBeVisible();
  await setup.getByRole("button", { name: "Ocean", exact: true }).click();
  await setup.screenshot({ path: "test-results/company-brand-preview.png" });
  await setup
    .getByRole("button", { name: "Reset to saved brand", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Loom home", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".app-shell")).toHaveCSS(
    "--brand-primary",
    "#19161e",
  );
  await setup.getByRole("button", { name: "Continue", exact: true }).click();
  await setup.getByRole("button", { name: /Codex Bring the agent/ }).click();
  await expect(
    setup.getByRole("button", { name: "Create agent connection", exact: true }),
  ).toBeDisabled();
  await expect(
    setup.getByLabel("Agent connection configuration", { exact: true }),
  ).toContainText('bearer_token_env_var = "LOOM_AGENT_TOKEN_WORKSPACE"');
});

test("company onboarding and agent configuration fit a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app?view=settings");
  // The sidebar collapses on small screens; setup also has a visible entry in the page.
  await page.locator("#company-setup > summary").click();
  const setup = page.locator("#company-setup");
  await setup.getByLabel("Company name", { exact: true }).fill("Nimbus Studio");
  await setup.getByRole("button", { name: "Continue", exact: true }).click();
  await setup.getByRole("button", { name: "Ember", exact: true }).click();
  await setup.getByRole("button", { name: "Continue", exact: true }).click();
  await setup.getByRole("button", { name: /Claude Code Connect/ }).click();
  await expect(
    setup.getByLabel("Agent connection configuration", { exact: true }),
  ).toContainText("Bearer ${LOOM_AGENT_TOKEN_WORKSPACE}");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await setup.screenshot({ path: "test-results/mobile-company-setup.png" });
});
