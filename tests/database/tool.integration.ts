import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  dataRequestTemplate,
  type Actor,
  type ModelInference,
  type ToolSpec,
} from "@loom/contracts";
import { isConfigured, readDatabase, writeDatabase } from "@loom/db-exasol";
import {
  createToolDraft,
  generateToolDraft,
  publishTool,
  toolWorkspace,
} from "../../apps/web/server/tools";

const model = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("../../apps/web/server/tool-generation", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../apps/web/server/tool-generation")
  >()),
  generateDefinition: model.generate,
}));
const inference: ModelInference = {
  requestedModel: "fixture/model:free",
  actualModel: "fixture/actual-model:free",
  generationId: "fixture-generation",
  promptVersion: "fixture-designer",
  promptTokens: 60,
  completionTokens: 120,
  cost: 0,
  durationMs: 15,
};
if (!isConfigured())
  throw new Error(
    "Live Exasol is required for tool-publication tests. Run db:migrate first.",
  );
const workspaceId = randomUUID(),
  otherWorkspaceId = randomUUID();
const owner: Actor = { workspaceId, userId: randomUUID() },
  operator: Actor = { workspaceId, userId: randomUUID() },
  outsider: Actor = { workspaceId: otherWorkspaceId, userId: owner.userId };
beforeAll(async () => {
  await writeDatabase(async (sql) => {
    for (const id of [workspaceId, otherWorkspaceId])
      await sql.execute("INSERT INTO WORKSPACES (ID,NAME) VALUES (?,?)", [
        id,
        "Tool publication fixture",
      ]);
    for (const [actor, role] of [
      [owner, "owner"],
      [operator, "operator"],
      [outsider, "owner"],
    ] as const)
      await sql.execute(
        "INSERT INTO MEMBERSHIPS (WORKSPACE_ID,USER_ID,NAME,ROLE,ACTIVE) VALUES (?,?,?,?,TRUE)",
        [actor.workspaceId, actor.userId, "Tool fixture", role],
      );
  });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await writeDatabase(async (sql) => {
    for (const table of [
      "TOOL_GENERATIONS",
      "TOOL_EVENTS",
      "TOOL_REVISIONS",
      "TOOL_DRAFTS",
      "TOOLS",
      "COMMAND_RECEIPTS",
      "MEMBERSHIPS",
      "WORKSPACES",
    ])
      for (const id of [workspaceId, otherWorkspaceId])
        await sql.execute(
          `DELETE FROM ${table} WHERE ${table === "WORKSPACES" ? "ID" : "WORKSPACE_ID"} = ?`,
          [id],
        );
  });
});
it("publishes exact reviewed immutable drafts, preserves baseline history, and rejects stale or foreign review", async () => {
  const initial = await toolWorkspace(owner);
  expect(initial.published.revision).toBe(1);
  expect(initial.published.spec).toEqual(dataRequestTemplate);
  const spec = { ...dataRequestTemplate, title: "IT request desk" },
    commandId = randomUUID();
  await expect(
    createToolDraft(operator, randomUUID(), 1, spec),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  const draft = await createToolDraft(owner, commandId, 1, spec);
  expect((await createToolDraft(owner, commandId, 1, spec)).id).toBe(draft.id);
  expect((await toolWorkspace(operator)).drafts).toEqual([]);
  await expect(
    publishTool(outsider, randomUUID(), draft.id, 1, draft.hash),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    publishTool(owner, randomUUID(), draft.id, 1, "0".repeat(64)),
  ).rejects.toMatchObject({ code: "DRAFT_CONFLICT" });
  const publicationId = randomUUID(),
    published = await publishTool(
      owner,
      publicationId,
      draft.id,
      1,
      draft.hash,
    );
  expect(published.revision).toBe(2);
  expect(
    await publishTool(owner, publicationId, draft.id, 1, draft.hash),
  ).toEqual(published);
  expect(
    (await toolWorkspace(owner)).history.map((entry) => entry.revision),
  ).toEqual([2, 1]);
  await expect(
    publishTool(owner, randomUUID(), draft.id, 1, draft.hash),
  ).rejects.toMatchObject({ code: "TOOL_REVISION_CONFLICT" });
  expect((await toolWorkspace(outsider)).published.revision).toBe(1);
});
it("reserves inference outside the write coordinator, reconciles once, and discards stale output", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "public-test-fixture");
  vi.stubEnv("OPENROUTER_MODEL", "fixture/model:free");
  vi.stubEnv("OPENROUTER_FREE_ONLY", "true");
  const current = (await toolWorkspace(owner)).published;
  let resolveModel!: (output: unknown) => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  model.generate.mockImplementationOnce(() => {
    entered();
    return new Promise((resolve) => {
      resolveModel = resolve;
    });
  });
  const commandId = randomUUID(),
    pending = generateToolDraft(
      owner,
      commandId,
      current.revision,
      "Refine this desk",
      current.spec,
    );
  await started;
  await expect(
    generateToolDraft(
      owner,
      commandId,
      current.revision,
      "Refine this desk",
      current.spec,
    ),
  ).rejects.toMatchObject({ code: "GENERATION_IN_PROGRESS" });
  await expect(
    createToolDraft(owner, commandId, current.revision, current.spec),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  const edited = await createToolDraft(owner, randomUUID(), current.revision, {
    ...current.spec,
    title: "Updated while inference runs",
  });
  await publishTool(
    owner,
    randomUUID(),
    edited.id,
    current.revision,
    edited.hash,
  );
  resolveModel({
    spec: { ...current.spec, title: "Stale model title" },
    assumptions: [],
    unsupported: [],
    inference,
  });
  await expect(pending).rejects.toMatchObject({
    code: "TOOL_REVISION_CONFLICT",
  });
  const generations = await readDatabase((sql) =>
    sql.query(
      "SELECT LIFECYCLE,DRAFT_ID FROM TOOL_GENERATIONS WHERE WORKSPACE_ID=? AND COMMAND_ID=?",
      [workspaceId, commandId],
    ),
  );
  expect(generations[0]).toMatchObject({ LIFECYCLE: "failed", DRAFT_ID: null });
  const latest = (await toolWorkspace(owner)).published;
  model.generate.mockResolvedValue({
    spec: { ...latest.spec, title: "Model draft" },
    assumptions: ["A reviewed draft only."],
    unsupported: [],
    inference,
  });
  const generationId = randomUUID(),
    draft = await generateToolDraft(
      owner,
      generationId,
      latest.revision,
      "Refine again",
      latest.spec,
    );
  expect(
    (
      await generateToolDraft(
        owner,
        generationId,
        latest.revision,
        "Refine again",
        latest.spec,
      )
    ).id,
  ).toBe(draft.id);
  expect(model.generate).toHaveBeenCalledTimes(2);
  expect(draft.inference).toEqual(inference);
  const reloaded = (await toolWorkspace(owner)).drafts.find(
    (entry) => entry.id === draft.id,
  );
  expect(reloaded?.inference).toEqual(inference);
  expect(
    (
      await generateToolDraft(
        owner,
        generationId,
        latest.revision,
        "Refine again",
        latest.spec,
      )
    ).inference,
  ).toEqual(inference);
});
it("rejects generated deletion or retyping of existing and edited fields before saving a draft", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "public-test-fixture");
  vi.stubEnv("OPENROUTER_MODEL", "fixture/model:free");
  vi.stubEnv("OPENROUTER_TOOL_MODEL", "fixture/model:free");
  vi.stubEnv("OPENROUTER_FREE_ONLY", "true");
  const current = (await toolWorkspace(owner)).published;
  const persisted: ToolSpec = {
    ...structuredClone(current.spec),
    fields: [
      ...current.spec.fields,
      {
        id: "custom_office",
        label: "Office",
        type: "text",
        requiredAt: "optional",
        maxLength: 100,
        visible: true,
      },
    ],
  };
  const draft = await createToolDraft(
    owner,
    randomUUID(),
    current.revision,
    persisted,
  );
  const published = await publishTool(
    owner,
    randomUUID(),
    draft.id,
    current.revision,
    draft.hash,
  );
  const base: ToolSpec = {
    ...structuredClone(published.spec),
    fields: [
      ...published.spec.fields,
      {
        id: "custom_reference",
        label: "Reference",
        type: "text",
        requiredAt: "optional",
        maxLength: 100,
        visible: true,
      },
    ],
  };
  const beforeCount = (await toolWorkspace(owner)).drafts.length;
  const retyped = structuredClone(base);
  retyped.fields.find((field) => field.id === "custom_office")!.type =
    "textarea";
  for (const spec of [
    {
      ...base,
      fields: base.fields.filter((field) => field.id !== "custom_office"),
    },
    {
      ...base,
      fields: base.fields.filter((field) => field.id !== "custom_reference"),
    },
    retyped,
  ]) {
    model.generate.mockResolvedValueOnce({
      spec,
      assumptions: [],
      unsupported: [],
      inference,
    });
    const commandId = randomUUID();
    await expect(
      generateToolDraft(
        owner,
        commandId,
        published.revision,
        "Refine the edited desk",
        base,
      ),
    ).rejects.toMatchObject({ code: "MODEL_OUTPUT_INCOMPATIBLE" });
    const [generation] = await readDatabase((sql) =>
      sql.query(
        "SELECT LIFECYCLE,DRAFT_ID FROM TOOL_GENERATIONS WHERE WORKSPACE_ID=? AND COMMAND_ID=?",
        [workspaceId, commandId],
      ),
    );
    expect(generation).toMatchObject({ LIFECYCLE: "failed", DRAFT_ID: null });
  }
  expect((await toolWorkspace(owner)).drafts).toHaveLength(beforeCount);
  expect((await toolWorkspace(owner)).published).toEqual(published);
});
