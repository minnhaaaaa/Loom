import { selectOption } from "../helpers/select";
import { expect, test } from "@playwright/test";

test("company setup previews brand colors, typography and identity without saving sample state", async ({
  page,
}) => {
  await page.goto("/app?demo=1");
  await page
    .getByRole("navigation", { name: "Main", exact: true })
    .getByRole("link", { name: "Settings", exact: true })
    .click();
  const setup = page.locator("#company-setup");
  await expect(setup).not.toHaveAttribute("open", "");
  await setup.locator(":scope > summary").click();
  await expect(setup.getByText("08", { exact: true })).toHaveCount(0);
  await expect(setup.getByText("03", { exact: true })).toHaveCount(0);
  await setup.getByLabel("Company name", { exact: true }).fill("Nimbus");
  await expect(
    page.getByRole("link", { name: "Nimbus home", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Nimbus home", exact: true }),
  ).toHaveText("Nimbus");
  await expect(page.locator(".company-logo, .company-seal")).toHaveCount(0);
  await setup.getByRole("button", { name: "Continue", exact: true }).click();
  await setup.getByRole("button", { name: "Indigo", exact: true }).click();
  await expect(page.locator(".app-shell")).toHaveCSS(
    "--brand-primary",
    "#3832a0",
  );
  await selectOption(
    setup.getByLabel("Typography", { exact: true }),
    "classic",
  );
  await selectOption(
    setup.getByLabel("Corner style", { exact: true }),
    "square",
  );
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
  await setup
    .getByRole("button", { name: /Codex Connect with your ChatGPT account/ })
    .click();
  await expect(
    setup.getByRole("button", { name: "Continue with ChatGPT", exact: true }),
  ).toBeVisible();
  await expect(
    setup.getByRole("button", { name: "Continue with ChatGPT", exact: true }),
  ).toBeDisabled();
  await expect(
    setup.getByLabel("Agent connection configuration", { exact: true }),
  ).toBeHidden();
  await setup.getByText("Local Codex connection", { exact: true }).click();
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
  await page.goto("/app?demo=1&view=settings");
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
