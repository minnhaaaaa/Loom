import { randomUUID } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import {
  dataRequestTemplate,
  type Actor,
  type Intake,
  type ToolSpec,
} from "@loom/contracts";
import { isConfigured, readDatabase, writeDatabase } from "@loom/db-exasol";
import {
  createRequest,
  details,
  mutateRequest,
  snapshot,
} from "../../apps/web/server/desk";
import { exportRequests } from "../../apps/web/server/imports";
import { parseCsv } from "../../apps/web/server/csv";
import { createToolDraft, publishTool } from "../../apps/web/server/tools";
import { changeRun, readRun, startRun } from "../../apps/web/server/triage";

if (!isConfigured())
  throw new Error(
    "Live Exasol is required for published-tool runtime tests. Run db:migrate first.",
  );
const workspaces: string[] = [];
async function fixture() {
  const workspaceId = randomUUID();
  const owner: Actor = { workspaceId, userId: randomUUID() };
  const requester: Actor = { workspaceId, userId: randomUUID() };
  workspaces.push(workspaceId);
  await writeDatabase(async (sql) => {
    await sql.execute("INSERT INTO WORKSPACES (ID,NAME) VALUES (?,?)", [
      workspaceId,
      "Published-tool runtime fixture",
    ]);
    for (const [actor, role] of [
      [owner, "owner"],
      [requester, "requester"],
    ] as const)
      await sql.execute(
        "INSERT INTO MEMBERSHIPS (WORKSPACE_ID,USER_ID,NAME,ROLE,ACTIVE) VALUES (?,?,?,?,TRUE)",
        [workspaceId, actor.userId, "Runtime fixture", role],
      );
  });
  return { owner, requester, workspaceId };
}
function customSpec(): ToolSpec {
  const spec = structuredClone(dataRequestTemplate);
  spec.fields.push({
    id: "custom_cost_center",
    label: "Cost center",
    type: "text",
    requiredAt: "optional",
    maxLength: 40,
    visible: true,
  });
  const queue = spec.views.find((view) => view.id === "queue");
  if (queue?.id === "queue") queue.columns.push("custom_cost_center");
  return spec;
}
async function publish(owner: Actor, revision: number, spec: ToolSpec) {
  const draft = await createToolDraft(owner, randomUUID(), revision, spec);
  return publishTool(owner, randomUUID(), draft.id, revision, draft.hash);
}
function values(): Intake {
  return {
    title: "Published-tool runtime fixture",
    businessQuestion: "Does the current published definition govern saves?",
    reportingPeriod: "October 2026",
    dataset: "Synthetic finance",
  };
}
afterAll(async () => {
  // Only UUID workspaces created by this file are touched, in dependency order.
  await writeDatabase(async (sql) => {
    for (const table of [
      "MODEL_ATTEMPTS",
      "AGENT_STEPS",
      "TRIAGE_PROPOSALS",
      "AGENT_EVENTS",
      "AGENT_RUNS",
      "KNOWLEDGE_ENTRIES",
      "IMPORT_BATCHES",
      "COMMENTS",
      "REQUEST_EVENTS",
      "AUDIT_EVENTS",
      "OUTBOX_EVENTS",
      "TOOL_GENERATIONS",
      "TOOL_EVENTS",
      "TOOL_REVISIONS",
      "TOOL_DRAFTS",
      "TOOLS",
      "COMMAND_RECEIPTS",
      "REQUESTS",
      "MEMBERSHIPS",
      "WORKSPACES",
    ])
      for (const id of workspaces)
        await sql.execute(
          `DELETE FROM ${table} WHERE ${table === "WORKSPACES" ? "ID" : "WORKSPACE_ID"} = ?`,
          [id],
        );
  });
});

it("persists a published custom field, retains it during edits, and exports it through authorized reads", async () => {
  const { owner, requester } = await fixture();
  const tool = await publish(owner, 1, customSpec());
  const record = await createRequest(
    requester,
    randomUUID(),
    { ...values(), customValues: { custom_cost_center: "FIN-101" } },
    tool.revision,
  );
  expect((await details(requester, record.id)).request.customValues).toEqual({
    custom_cost_center: "FIN-101",
  });
  const edited = await mutateRequest(
    requester,
    record.id,
    randomUUID(),
    record.version,
    {
      type: "edit_description",
      values: { ...values(), title: "Updated title with retained details" },
    },
    tool.revision,
  );
  expect(edited.customValues).toEqual({ custom_cost_center: "FIN-101" });
  expect((await details(owner, record.id)).request.customValues).toEqual({
    custom_cost_center: "FIN-101",
  });
  expect((await snapshot(requester)).tool?.revision).toBe(tool.revision);
  const [headers, row] = parseCsv(await exportRequests(owner, {}));
  expect(row[headers.indexOf("custom_cost_center")]).toBe("FIN-101");
  await expect(
    createRequest(
      requester,
      randomUUID(),
      { ...values(), customValues: { custom_unknown: "Forged field" } },
      tool.revision,
    ),
  ).rejects.toMatchObject({ code: "UNKNOWN_TOOL_FIELD" });
});

it("keeps existing records when a readiness field is added and blocks progress until it is supplied", async () => {
  const { owner, requester } = await fixture();
  const optional = await publish(owner, 1, customSpec());
  const record = await createRequest(
    requester,
    randomUUID(),
    values(),
    optional.revision,
  );
  const required = structuredClone(optional.spec);
  required.fields.find(
    (field) => field.id === "custom_cost_center",
  )!.requiredAt = "ready";
  const current = await publish(owner, optional.revision, required);
  await expect(
    mutateRequest(
      owner,
      record.id,
      randomUUID(),
      record.version,
      { type: "set_status", status: "ready" },
      current.revision,
    ),
  ).rejects.toMatchObject({ code: "MISSING_REQUIREMENTS" });
  expect((await details(requester, record.id)).request).toMatchObject({
    version: record.version,
    status: "new",
  });
  const completed = await mutateRequest(
    requester,
    record.id,
    randomUUID(),
    record.version,
    {
      type: "edit_description",
      values: { ...values(), customValues: { custom_cost_center: "OPS-202" } },
    },
    current.revision,
  );
  const ready = await mutateRequest(
    owner,
    record.id,
    randomUUID(),
    completed.version,
    { type: "set_status", status: "ready" },
    current.revision,
  );
  expect(ready).toMatchObject({
    status: "ready",
    customValues: { custom_cost_center: "OPS-202" },
  });
});

it("rejects stale form revisions and disabled actions without saving records, receipts, or partial edits", async () => {
  const { owner, requester, workspaceId } = await fixture();
  const record = await createRequest(requester, randomUUID(), values(), 1);
  const next = structuredClone(dataRequestTemplate);
  next.title = "Republished runtime desk";
  next.actions = next.actions.filter(
    (action) => action !== "request.set_priority",
  );
  const current = await publish(owner, 1, next);
  const createId = randomUUID(),
    editId = randomUUID(),
    disabledId = randomUUID();
  await expect(
    createRequest(requester, createId, values(), 1),
  ).rejects.toMatchObject({ code: "TOOL_REVISION_CONFLICT" });
  await expect(
    mutateRequest(
      requester,
      record.id,
      editId,
      record.version,
      {
        type: "edit_description",
        values: { ...values(), title: "Stale edit" },
      },
      1,
    ),
  ).rejects.toMatchObject({ code: "TOOL_REVISION_CONFLICT" });
  await expect(
    mutateRequest(
      owner,
      record.id,
      disabledId,
      record.version,
      { type: "set_priority", priority: "high" },
      current.revision,
    ),
  ).rejects.toMatchObject({ code: "TOOL_ACTION_DISABLED" });
  expect((await details(requester, record.id)).request).toMatchObject({
    title: values().title,
    version: record.version,
  });
  expect((await snapshot(requester)).requests).toHaveLength(1);
  const receipts = await readDatabase((sql) =>
    sql.query(
      "SELECT COMMAND_ID FROM COMMAND_RECEIPTS WHERE WORKSPACE_ID = ? AND COMMAND_ID IN (?,?,?)",
      [workspaceId, createId, editId, disabledId],
    ),
  );
  expect(receipts).toEqual([]);
});

it("invalidates a pinned agent run after publication before reserving or calling the model", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "public-test-only");
  vi.stubEnv("OPENROUTER_MODEL", "fixture/test:free");
  vi.stubEnv("OPENROUTER_FREE_ONLY", "true");
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("A stale run must never call a provider."));
  try {
    const { owner, requester, workspaceId } = await fixture();
    const record = await createRequest(requester, randomUUID(), values(), 1);
    const run = await startRun(
      owner,
      randomUUID(),
      [record.id],
      "Review this synthetic request for missing requirements.",
    );
    expect(run.toolRevision).toBe("request-desk-v1");
    const next = structuredClone(dataRequestTemplate);
    next.title = "Republished after the agent started";
    await publish(owner, 1, next);
    const advanceId = randomUUID();
    await expect(
      changeRun(owner, run.id, advanceId, run.version, "advance"),
    ).rejects.toMatchObject({ code: "STALE_TOOL" });
    expect(transport).not.toHaveBeenCalled();
    expect((await readRun(owner, run.id)).run).toMatchObject({
      version: run.version,
      status: "queued",
      checkpoint: 0,
    });
    const saved = await readDatabase(async (sql) => ({
      attempts: await sql.query(
        "SELECT ID FROM MODEL_ATTEMPTS WHERE WORKSPACE_ID = ? AND RUN_ID = ?",
        [workspaceId, run.id],
      ),
      receipts: await sql.query(
        "SELECT COMMAND_ID FROM COMMAND_RECEIPTS WHERE WORKSPACE_ID = ? AND COMMAND_ID = ?",
        [workspaceId, advanceId],
      ),
    }));
    expect(saved).toEqual({ attempts: [], receipts: [] });
  } finally {
    transport.mockRestore();
    vi.unstubAllEnvs();
  }
});
