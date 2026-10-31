import { expect, test } from "@playwright/test";
import {
  personas,
  type PublishedTool,
  type ToolWorkspace,
} from "../../packages/contracts/src/index";

test("an owner publishes a reviewed tool and a requester opens the same definition", async ({
  page,
  request,
}) => {
  const origin = "http://127.0.0.1:3200";
  await request.post("/api/session", {
    headers: { Origin: origin },
    data: { userId: personas[0].id },
  });
  const original = (
    (await (await request.get("/api/tool")).json()) as ToolWorkspace
  ).published;
  const before = (await (await request.get("/api/desk")).json()).requests.map(
    (record: { id: string; version: number }) => [record.id, record.version],
  );
  const title = `Support desk ${crypto.randomUUID().slice(0, 8)}`;
  try {
    await page.goto("/app?view=settings");
    await page
      .getByRole("combobox", { name: "Demo persona" })
      .selectOption(personas[0].id);
    const builder = page.locator(".tool-builder");
    await builder.getByText("Customize this desk", { exact: true }).click();
    await builder
      .getByRole("button", { name: "IT requests", exact: true })
      .click();
    await builder.getByLabel("Tool title", { exact: true }).fill(title);
    await expect(page.locator(".current-tool-label")).toContainText(
      original.spec.title,
    );
    await builder
      .getByRole("button", { name: "Save draft for review", exact: true })
      .click();
    const review = builder.getByRole("checkbox", {
      name: "I reviewed this saved draft and its exact changes.",
      exact: true,
    });
    await expect(review).toBeVisible();
    await expect(
      builder.getByRole("button", {
        name: "Publish reviewed tool",
        exact: true,
      }),
    ).toBeDisabled();
    await review.check();
    await builder
      .getByRole("button", { name: "Publish reviewed tool", exact: true })
      .click();
    await expect(page.locator(".current-tool-label")).toContainText(title);
    await page.reload();
    await expect(page.locator(".current-tool-label")).toContainText(title);
    await page
      .getByRole("combobox", { name: "Demo persona" })
      .selectOption(personas[2].id);
    await expect(page.locator(".tool-builder")).toHaveCount(0);
    await page.goto("/app?view=records");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
    await page
      .getByRole("button", { name: "New request", exact: true })
      .click();
    const form = page.getByRole("dialog");
    await expect(
      form.getByLabel("System or service", { exact: true }),
    ).toBeVisible();
    await expect(
      form.getByLabel("What do you need help with?", { exact: true }),
    ).toBeVisible();
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
    const after = (await (await request.get("/api/desk")).json()).requests.map(
      (record: { id: string; version: number }) => [record.id, record.version],
    );
    expect(after).toEqual(before);
    await page.screenshot({
      path: "test-results/connected-tool-builder.png",
      fullPage: true,
    });
  } finally {
    // Restore the original compatible definition through ordinary reviewed publication.
    const current = (
      (await (await request.get("/api/tool")).json()) as ToolWorkspace
    ).published;
    if (JSON.stringify(current.spec) !== JSON.stringify(original.spec)) {
      const draftResponse = await request.post("/api/tool/drafts", {
        headers: { Origin: origin },
        data: {
          commandId: crypto.randomUUID(),
          expectedRevision: current.revision,
          spec: original.spec,
          instructions:
            "Restore the definition used before the synthetic browser check.",
        },
      });
      expect(draftResponse.ok()).toBe(true);
      const draft = await draftResponse.json();
      const restored = await request.post("/api/tool/publish", {
        headers: { Origin: origin },
        data: {
          commandId: crypto.randomUUID(),
          draftId: draft.id,
          expectedRevision: current.revision,
          hash: draft.hash,
        },
      });
      expect(restored.ok()).toBe(true);
      expect(((await restored.json()) as PublishedTool).spec).toEqual(
        original.spec,
      );
    }
  }
});
