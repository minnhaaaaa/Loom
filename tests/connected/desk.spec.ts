import { expect, test } from "@playwright/test";
import { personas } from "../../packages/contracts/src/index";
const origin = "http://127.0.0.1:3200";
test("real Exasol workflow through the production UI and protected API", async ({
  page,
  request,
}) => {
  const title = `Browser fixture ${crypto.randomUUID().slice(0, 8)}`;
  await page.goto("/app?view=records");
  await page
    .getByRole("combobox", { name: "Demo persona" })
    .selectOption(personas[2].id);
  await expect(
    page.getByRole("button", { name: "New request", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", {
      name: "Refresh the operations scorecard",
      exact: true,
    }),
  ).not.toBeVisible();
  await page.getByRole("button", { name: "New request", exact: true }).click();
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

test("CSV mapping, review, explicit commit, and scoped download in the production UI", async ({
  page,
}) => {
  const title = `CSV browser ${crypto.randomUUID().slice(0, 8)}`;
  await page.goto("/app?view=records");
  await page
    .getByRole("combobox", { name: "Demo persona" })
    .selectOption(personas[0].id);
  await expect(
    page.getByRole("button", { name: "New request", exact: true }),
  ).toBeEnabled();
  await page.getByText("CSV import / export", { exact: true }).click();
  await page.getByLabel("Choose CSV").setInputFiles({
    name: "synthetic.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      `Summary,Question,Period,Data\n${title},Why is this waiting?,,\n`,
    ),
  });
  await expect(
    page.getByRole("button", { name: "Generate import preview" }),
  ).toBeVisible();
  const transfer = page.locator(".csv-transfer");
  for (const [field, value] of [
    ["Request title", "0"],
    ["Business question", "1"],
    ["Reporting period", "2"],
    ["Dataset", "3"],
  ])
    await transfer
      .getByRole("combobox", { name: field, exact: true })
      .selectOption(value);
  await transfer
    .getByRole("button", { name: "Generate import preview" })
    .click();
  await expect(
    transfer.getByText(
      "Missing readiness context; imported as Needs information.",
    ),
  ).toBeVisible();
  await expect(
    transfer.getByRole("button", { name: "Commit reviewed import" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: title, exact: true }),
  ).not.toBeVisible();
  await transfer.getByRole("checkbox").check();
  await transfer
    .getByRole("button", { name: "Commit reviewed import" })
    .click();
  await expect(
    transfer.getByText("This batch is already saved (1 requests)."),
  ).toBeVisible();
  await page.getByRole("searchbox").fill(title);
  const queue = page.getByRole("region", { name: "Request queue" });
  await expect(queue.getByRole("row")).toHaveCount(2);
  await expect(
    queue.getByRole("table").getByText("Needs information", { exact: true }),
  ).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await transfer.getByRole("button", { name: "Export matching CSV" }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("loom-requests.csv");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const csv = Buffer.concat(chunks).toString("utf8");
  expect(csv).toContain(title);
  expect(csv).toContain('"needs_info"');
  await page
    .getByRole("combobox", { name: "Demo persona" })
    .selectOption(personas[2].id);
  await expect(
    page.getByText("Your work, in view", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("searchbox")).toHaveValue("");
  await page.getByRole("searchbox").fill(title);
  await expect(
    page.getByRole("heading", { name: "No matching requests" }),
  ).toBeVisible();
  await page.getByText("CSV import / export", { exact: true }).click();
  await expect(page.getByLabel("Choose CSV")).not.toBeVisible();
  await page.screenshot({
    path: "test-results/connected-csv-requester.png",
    fullPage: true,
  });
});

test("live OpenRouter proposal and exact-change human review in the production UI", async ({
  page,
  request,
}) => {
  test.skip(
    process.env.LOOM_TEST_LIVE_MODEL !== "true" ||
      !process.env.OPENROUTER_API_KEY ||
      !process.env.OPENROUTER_MODEL,
    "Live OpenRouter tests require explicit opt-in, model, and credentials; no fake production fallback.",
  );
  test.setTimeout(150_000);
  const suffix = crypto.randomUUID().slice(0, 8),
    title = `Triage browser ${suffix}`,
    dataset = `Browser events ${suffix}`,
    source = `Route browser ${suffix}`;
  await request.post("/api/session", {
    headers: { Origin: origin },
    data: { userId: personas[2].id },
  });
  const created = await request.post("/api/requests", {
    headers: { Origin: origin },
    data: {
      commandId: crypto.randomUUID(),
      values: {
        title,
        businessQuestion: "Which synthetic requests need context?",
        dataset,
      },
    },
  });
  expect(created.status()).toBe(200);
  const record = await created.json();
  await page.goto("/app?view=settings");
  await page
    .getByRole("combobox", { name: "Demo persona" })
    .selectOption(personas[0].id);
  await page.locator(".advanced-administration > summary").click();
  const workspace = page.getByRole("region", {
    name: "Triage and team knowledge",
  });
  await expect(workspace).toBeVisible();
  await workspace.getByText("Team knowledge", { exact: true }).click();
  await workspace
    .getByRole("textbox", { name: "Knowledge title", exact: true })
    .fill(source);
  await workspace
    .getByRole("combobox", { name: "Knowledge kind", exact: true })
    .selectOption("routing");
  await workspace
    .getByRole("textbox", { name: "Dataset context (optional)", exact: true })
    .fill(dataset);
  await workspace
    .getByRole("combobox", { name: "Owner context (optional)", exact: true })
    .selectOption(personas[1].id);
  await workspace
    .getByRole("textbox", { name: "Knowledge content", exact: true })
    .fill(
      "For requests concerning this dataset, Rohan is the responsible analyst. Use an internal clarification draft to ask for missing reporting periods.",
    );
  await workspace
    .getByRole("button", { name: "Save knowledge draft", exact: true })
    .click();
  await workspace
    .getByRole("button", { name: `Approve knowledge: ${source}`, exact: true })
    .click();
  await expect(
    workspace.getByText("Knowledge approved.", { exact: true }),
  ).toBeVisible();
  await workspace
    .getByText("Run triage and review proposals", { exact: true })
    .click();
  await workspace.getByRole("checkbox", { name: title, exact: true }).check();
  await workspace
    .getByRole("textbox", { name: "Instructions for the model", exact: true })
    .fill(
      "Propose assigning this request to the responsible analyst from approved knowledge, ask internally for its missing reporting period, and mark it Needs information. Cite the supporting source. Leave all other fields unchanged.",
    );
  await workspace
    .getByRole("button", { name: "Start triage (1)", exact: true })
    .click();
  await workspace
    .getByRole("button", { name: "Process next request", exact: true })
    .click();
  const proposal = workspace.locator(".proposal-review");
  await expect(
    proposal.getByRole("heading", { name: `Review: ${title}` }),
  ).toBeVisible({ timeout: 105_000 });
  await expect(
    proposal.getByText("Exact model-proposed actions", { exact: true }),
  ).toBeVisible();
  await expect(
    proposal.getByRole("button", {
      name: `Approve changes: ${title}`,
      exact: true,
    }),
  ).toBeDisabled();
  const before = await (await request.get(`/api/requests/${record.id}`)).json();
  expect(before.request).toMatchObject({
    version: 1,
    ownerId: null,
    status: "new",
  });
  await page.reload();
  await page.locator(".advanced-administration > summary").click();
  const restored = page.getByRole("region", {
    name: "Triage and team knowledge",
  });
  await restored
    .getByText("Run triage and review proposals", { exact: true })
    .click();
  const recent = restored.getByRole("combobox", {
    name: "Recent runs (workspace latest 10)",
    exact: true,
  });
  await expect(recent.locator("option").nth(1)).toHaveAttribute("value", /.+/);
  await recent.selectOption({ index: 1 });
  const restoredProposal = restored.locator(".proposal-review");
  await expect(
    restoredProposal.getByRole("heading", { name: `Review: ${title}` }),
  ).toBeVisible();
  await restoredProposal
    .getByRole("button", { name: `${source} · v2`, exact: true })
    .click();
  await expect(
    restored.getByRole("complementary", { name: "Knowledge evidence" }),
  ).toContainText("responsible analyst");
  await restoredProposal
    .getByRole("checkbox", {
      name: "I reviewed these exact changes and evidence.",
      exact: true,
    })
    .check();
  await restoredProposal
    .getByRole("button", { name: `Approve changes: ${title}`, exact: true })
    .click();
  await expect(
    restored.getByText("Reviewed changes saved atomically.", { exact: true }),
  ).toBeVisible();
  const after = await (await request.get(`/api/requests/${record.id}`)).json();
  expect(after.request).toMatchObject({
    ownerId: personas[1].id,
    status: "needs_info",
  });
  expect(after.comments).toEqual([]);
  await page.screenshot({
    path: "test-results/connected-triage.png",
    fullPage: true,
  });
  await page
    .getByRole("combobox", { name: "Demo persona" })
    .selectOption(personas[2].id);
  await expect(
    page.getByRole("region", { name: "Triage and team knowledge" }),
  ).not.toBeVisible();
  expect((await request.get("/api/runs")).status()).toBe(403);
});

test("model configuration is explicit and an unconfigured run cannot use a heuristic fallback", async ({
  request,
}) => {
  test.skip(
    Boolean(process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_MODEL),
    "This check requires an unconfigured provider.",
  );
  await request.post("/api/session", {
    headers: { Origin: origin },
    data: { userId: personas[0].id },
  });
  const state = await (await request.get("/api/runs")).json();
  expect(state.configuration.configured).toBe(false);
  const desk = await (await request.get("/api/desk")).json();
  const response = await request.post("/api/runs", {
    headers: { Origin: origin },
    data: {
      commandId: crypto.randomUUID(),
      requestIds: [desk.requests[0].id],
      instructions: "Review this request.",
    },
  });
  expect(response.status()).toBe(503);
  expect((await response.json()).error.code).toBe("MODEL_NOT_CONFIGURED");
});
