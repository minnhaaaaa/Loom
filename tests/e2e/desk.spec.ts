import { expect, test } from "@playwright/test";
import { personas } from "../../packages/contracts/src/index";
test("preview is explicitly read-only and supports queue inspection", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/app?view=records");
  await expect(
    page.getByText("Read-only sample preview", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Data requests", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(5);
  await page.screenshot({
    path: "test-results/desktop-preview.png",
    fullPage: true,
  });
  await page.getByRole("searchbox").fill("returns");
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(2);
  await page
    .getByRole("button", { name: "Returns by product category", exact: true })
    .click();
  const panel = page.getByRole("dialog");
  await expect(
    panel.getByRole("heading", { name: "Returns by product category" }),
  ).toBeVisible();
  await expect(panel.getByLabel("Business question")).toHaveValue(
    "Which categories account for the largest share of returns?",
  );
  await expect(
    panel.getByRole("button", { name: "Save description" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(panel).not.toBeVisible();
  await page.getByRole("searchbox").fill("nothing matching");
  await expect(
    page.getByRole("heading", { name: "No matching requests" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test("intake renders the supported field specification without pretending to save", async ({
  page,
}) => {
  await page.goto("/app?view=records");
  await page
    .getByRole("button", { name: "+ New request", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("Request title").fill("Example request");
  await page.getByLabel("Business question").fill("What changed this week?");
  await expect(
    page.getByRole("button", { name: "Create request", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
});
test("mobile preview keeps the page within the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app?view=records");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Weekly acquisition funnel", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/mobile-preview.png",
    fullPage: true,
  });
});
test("API denies forged mutations, validates sessions, and fails closed without Exasol", async ({
  request,
}) => {
  const origin = "http://127.0.0.1:3100";
  const foreign = await request.post("/api/session", {
    headers: { Origin: "https://untrusted.example" },
    data: { userId: personas[0].id },
  });
  expect(foreign.status()).toBe(403);
  const unauthenticated = await request.post("/api/requests", {
    headers: { Origin: origin },
    data: {},
  });
  expect(unauthenticated.status()).toBe(401);
  const tampered = await request.get("/api/desk", {
    headers: {
      Cookie: `loom_demo_session=${personas[0].id}.${Date.now()}.${"a".repeat(43)}`,
    },
  });
  expect(tampered.status()).toBe(401);
  const session = await request.post("/api/session", {
    headers: { Origin: origin },
    data: { userId: personas[0].id },
  });
  expect(session.status()).toBe(200);
  const invalid = await request.post("/api/requests", {
    headers: { Origin: origin },
    data: {
      commandId: crypto.randomUUID(),
      values: { title: "Bad patch", businessQuestion: "Why?", status: "done" },
    },
  });
  expect(invalid.status()).toBe(422);
  const save = await request.post("/api/requests", {
    headers: { Origin: origin },
    data: {
      commandId: crypto.randomUUID(),
      values: { title: "A request", businessQuestion: "Why?" },
    },
  });
  expect(save.status()).toBe(503);
  expect((await save.json()).error.code).toBe("DATABASE_UNAVAILABLE");
  expect(save.headers()["cache-control"]).toContain("no-store");
});
