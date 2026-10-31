import { expect, test } from "@playwright/test";

test("landing explains the analytics workflow and opens the explicit sample desk", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    /DATA REQUESTS\.\s*ONE WORKSPACE\./,
  );
  await expect(
    page.getByText("For small analytics teams", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/bring the loose ends together|many loose ends/i),
  ).toHaveCount(0);
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
  await page.getByRole("link", { name: "Explore sample", exact: true }).click();
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

test("scroll reveals remain usable after leaving and returning to the landing page", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("link", { name: "Product", exact: true }).click();
  await expect(page).toHaveURL(/\/#product$/);
  const productHeading = page.getByRole("heading", { level: 2 });
  await expect(productHeading).toHaveText(/REQUEST\.\s*ASSIGN\.\s*DELIVER\./);
  await expect(productHeading).toBeVisible();
  await expect(page.getByText("Weekly revenue", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Open the desk", exact: true }).click();
  await expect(page).toHaveURL(/\/app\?demo=1$/);
  await expect(
    page.getByText("Read-only sample preview", { exact: true }),
  ).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/#product$/);
  await expect(productHeading).toBeVisible();
  const start = page.getByRole("link", {
    name: "Start with your team",
    exact: true,
  });
  await start.scrollIntoViewIfNeeded();
  await expect(start).toBeVisible();
  await expect(start).toBeInViewport();
  await start.click();
  await expect(page).toHaveURL(/\/register$/);
  await expect(page.getByLabel("Company name", { exact: true })).toBeVisible();
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
    if (route === "/") {
      for (const name of [
        "Create your company",
        "Explore sample",
        "Open the desk",
        "Start with your team",
      ]) {
        const link = page.getByRole("link", { name, exact: true });
        await link.scrollIntoViewIfNeeded();
        await expect(link).toBeVisible();
        await expect(link).toBeInViewport();
      }
      await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
      await expect(
        page.getByText("Retention cohorts", { exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    }
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
