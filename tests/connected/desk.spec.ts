import { expect, test } from "@playwright/test";
import { personas } from "../../packages/contracts/src/index";
const origin = "http://127.0.0.1:3200";
test("real Exasol workflow through the production UI and protected API", async ({
  page,
  request,
}) => {
  const title = `Browser fixture ${crypto.randomUUID().slice(0, 8)}`;
  await page.goto("/");
  await page
    .getByRole("combobox", { name: "Demo persona" })
    .selectOption(personas[2].id);
  await expect(
    page.getByRole("button", { name: "+ New request", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", {
      name: "Refresh the operations scorecard",
      exact: true,
    }),
  ).not.toBeVisible();
  await page
    .getByRole("button", { name: "+ New request", exact: true })
    .click();
  const panel = page.getByRole("dialog");
  await panel.getByLabel("Request title").fill(title);
  await panel
    .getByLabel("Business question")
    .fill(
      "Can the real browser workflow persist and retrieve this synthetic request?",
    );
  await panel.getByLabel("Reporting period").fill("October 2026");
  await panel.getByLabel("Dataset").fill("Synthetic test events");
  await panel
    .getByRole("button", { name: "Create request", exact: true })
    .click();
  await expect(panel).not.toBeVisible();
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect(panel.getByLabel("Business question")).toHaveValue(
    "Can the real browser workflow persist and retrieve this synthetic request?",
  );
  await panel
    .getByLabel("Add a comment")
    .fill("Public synthetic browser test note.");
  await panel.getByRole("button", { name: "Add comment", exact: true }).click();
  await expect(
    panel.getByText("Public synthetic browser test note.", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "Coordination" }),
  ).not.toBeVisible();
  await panel.getByRole("button", { name: "Close request panel" }).click();
  await page
    .getByRole("combobox", { name: "Demo persona" })
    .selectOption(personas[0].id);
  await expect(page.getByText(/Exasol · queue-summary-v1/)).toBeVisible();
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect(
    panel.getByRole("combobox", { name: "Owner", exact: true }),
  ).toBeEnabled();
  await panel
    .getByRole("combobox", { name: "Owner", exact: true })
    .selectOption(personas[1].id);
  await expect(
    panel.getByRole("combobox", { name: "Owner", exact: true }),
  ).toHaveValue(personas[1].id);
  for (const status of ["ready", "in_progress", "done"]) {
    await expect(
      panel.getByRole("combobox", { name: "Status", exact: true }),
    ).toBeEnabled();
    await panel
      .getByRole("combobox", { name: "Status", exact: true })
      .selectOption(status);
    await expect(
      panel.getByRole("combobox", { name: "Status", exact: true }),
    ).toHaveValue(status);
  }
  await page.screenshot({
    path: "test-results/connected-desk.png",
    fullPage: true,
  });
  await panel.getByRole("button", { name: "Close request panel" }).click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: title, exact: true }),
  ).toBeVisible();
  // Exercise the actual production routes, independent from UI control hiding.
  await request.post("/api/session", {
    headers: { Origin: origin },
    data: { userId: personas[0].id },
  });
  const desk = await (await request.get("/api/desk")).json();
  const record = desk.requests.find(
    (r: { title: string }) => r.title === title,
  );
  expect(record.status).toBe("done");
  expect(record.ownerId).toBe(personas[1].id);
  const sharedCommandId = crypto.randomUUID();
  const competing = await Promise.all([
    request.post("/api/requests", {
      headers: { Origin: origin },
      data: {
        commandId: sharedCommandId,
        values: {
          title: `Cross-route fixture ${sharedCommandId.slice(0, 8)}`,
          businessQuestion: "Synthetic cross-route command identity check.",
        },
      },
    }),
    request.post(`/api/requests/${record.id}/commands`, {
      headers: { Origin: origin },
      data: {
        commandId: sharedCommandId,
        expectedVersion: record.version,
        command: { type: "set_priority", priority: "high" },
      },
    }),
  ]);
  expect(competing.map((r) => r.status()).sort()).toEqual([200, 409]);
  if (competing[0].status() === 200) {
    const created = await competing[0].json();
    expect(
      (
        await request.post(`/api/requests/${created.id}/commands`, {
          headers: { Origin: origin },
          data: {
            commandId: crypto.randomUUID(),
            expectedVersion: created.version,
            command: { type: "set_status", status: "cancelled" },
          },
        })
      ).status(),
    ).toBe(200);
  }
  await request.post("/api/session", {
    headers: { Origin: origin },
    data: { userId: personas[2].id },
  });
  const forged = await request.post(`/api/requests/${record.id}/commands`, {
    headers: { Origin: origin },
    data: {
      commandId: crypto.randomUUID(),
      expectedVersion: record.version,
      command: { type: "set_owner", ownerId: personas[2].id },
    },
  });
  expect(forged.status()).toBe(403);
  expect((await request.get("/api/analytics")).status()).toBe(403);
  await request.post("/api/session", {
    headers: { Origin: origin },
    data: { userId: personas[3].id },
  });
  expect(
    (
      await request.post("/api/requests", {
        headers: { Origin: origin },
        data: {
          commandId: crypto.randomUUID(),
          values: { title: "Viewer forgery", businessQuestion: "Should fail." },
        },
      })
    ).status(),
  ).toBe(403);
});
