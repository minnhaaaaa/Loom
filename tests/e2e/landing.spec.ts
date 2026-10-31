import { expect, test } from "@playwright/test";

test("landing explains the analytics workflow and opens the explicit sample desk", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Less chasing.More analysis.",
  );
  await expect(
    page.getByText("Built for small analytics teams", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("link", { name: "Create your company", exact: true })
      .first(),
  ).toHaveAttribute("href", "/register");
  await page
    .getByRole("link", { name: "Sign in", exact: true })
    .first()
    .click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel("Email address", { exact: true })).toBeVisible();
  await page.goto("/");
  await page
    .getByRole("link", { name: "Explore the sample desk", exact: true })
    .click();
  await expect(page).toHaveURL(/\/app\?demo=1$/);
  await expect(
    page.getByText("Read-only sample preview", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Flow insights", exact: true }).click();
  await expect(page).toHaveURL(/demo=1&view=insights/);
  await expect(
    page.getByText("There is no live history in this sample workspace.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("landing and company entry fit a phone with reduced motion", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const route of ["/", "/register", "/login"]) {
    await page.goto(route);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
});

test("older workspace bookmarks still resolve to the workspace", async ({
  page,
}) => {
  await page.goto("/?view=assistant");
  await expect(page).toHaveURL(/\/app\?view=assistant$/);
  await expect(
    page.getByRole("textbox", { name: "Ask your workspace", exact: true }),
  ).toBeVisible();
});
