import { expect, test, type Page } from "@playwright/test";

test("localhost entry redirects once to the canonical OAuth origin", async ({
  page,
  baseURL,
}) => {
  const alias = new URL("/login?from=landing", baseURL);
  alias.hostname = "localhost";
  await page.goto(alias.href);
  await expect(page).toHaveURL(`${baseURL}/login?from=landing`);
  await expect(page.getByLabel("Email address", { exact: true })).toBeVisible();
});

async function openLanding(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Skip intro", exact: true }).click();
  await expect(page.locator(".loom-landing")).toHaveAttribute(
    "data-intro-phase",
    "complete",
  );
}

test("landing explains the analytics workflow and offers account entry without sample links", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLanding(page);
  await expect(page.locator(".loom-weave")).toBeVisible();
  await expect(page.locator("canvas")).toHaveCount(0);
  await expect(page.locator(".loom-thread-weft").last()).toHaveCSS(
    "opacity",
    "0.95",
  );
  await page.screenshot({
    path: "test-results/landing-weave-desktop.png",
    fullPage: true,
  });
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
  await expect(page.getByRole("link", { name: /sample/i })).toHaveCount(0);
  await expect(page.locator('a[href*="demo="]')).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /pause|play|stop/i }),
  ).toHaveCount(0);
  await page
    .getByRole("link", { name: "Sign in", exact: true })
    .first()
    .click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel("Email address", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("landing stays minimal and works after returning from sign-in", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openLanding(page);
  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(0);
  await expect(page.locator("#product")).toHaveCount(0);
  await page
    .locator(".loom-hero-actions")
    .getByRole("link", { name: "Sign in", exact: true })
    .click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  const skip = page.getByRole("button", { name: "Skip intro", exact: true });
  if (await skip.isVisible()) await skip.click();
  await page
    .getByRole("link", { name: "Create your company", exact: true })
    .click();
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
    await expect(page.getByRole("link", { name: /sample/i })).toHaveCount(0);
    await expect(page.locator('a[href*="demo="]')).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    if (route === "/") {
      for (const name of ["Create your company", "Sign in"]) {
        const link = page
          .locator(".loom-hero-actions")
          .getByRole("link", { name, exact: true });
        await link.scrollIntoViewIfNeeded();
        await expect(link).toBeVisible();
        await expect(link).toBeInViewport();
      }
      await expect(page.locator(".loom-intro")).toHaveCount(0);
      await expect(page.locator(".loom-weave")).toBeVisible();
      await page.screenshot({
        path: "test-results/landing-weave-mobile.png",
        fullPage: true,
      });
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

test("opening loads, types LOOM, shows only the headline, then reveals the page", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator('[data-intro-phase="wordmark"]')).toBeAttached({
    timeout: 10000,
  });
  await expect(page.locator(".loom-intro-word")).toBeVisible();
  await expect(page.locator('[data-intro-phase="headline"]')).toBeAttached();
  await expect(page.locator(".loom-hero-title")).toBeVisible();
  const letters = page.locator(".loom-headline-letter");
  await expect(letters.first()).toHaveCSS("opacity", "1");
  await expect(letters.last()).toHaveCSS("opacity", "0");
  const introHeading = await page.locator("h1").boundingBox();
  expect(
    Math.abs(
      introHeading!.y +
        introHeading!.height / 2 -
        page.viewportSize()!.height / 2,
    ),
  ).toBeLessThan(2);
  await expect(page.locator(".loom-hero-art")).toBeHidden();
  await expect(page.locator(".loom-nav")).toBeHidden();
  await expect(page.locator(".loom-hero-actions")).toBeHidden();
  await expect(page.locator('[data-intro-phase="complete"]')).toBeAttached({
    timeout: 10000,
  });
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(letters.last()).toHaveCSS("opacity", "1");
  const heading = await page.getByRole("heading", { level: 1 }).boundingBox();
  expect(heading).not.toBeNull();
  expect(
    Math.abs(heading!.x + heading!.width / 2 - page.viewportSize()!.width / 2),
  ).toBeLessThan(2);
  await expect(
    page
      .locator(".loom-hero-actions")
      .getByRole("link", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".loom-site")).not.toHaveAttribute("inert");
});

test("Escape skips the intro and restores keyboard access", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Skip intro", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-intro-phase="complete"]')).toBeAttached();
  await expect(page.locator("main")).toBeFocused();
  await expect(page.locator(".loom-site")).not.toHaveAttribute("inert");
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
});

test("landing remains available without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.locator(".loom-intro")).toBeHidden();
  await expect(page.locator(".loom-weave")).toBeVisible();
  await expect(page.locator("canvas")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page
    .getByRole("link", { name: "Create your company", exact: true })
    .click();
  await expect(page).toHaveURL(/\/register$/);
  await context.close();
});
