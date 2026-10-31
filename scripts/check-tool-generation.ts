import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dataRequestTemplate, type Actor } from "@loom/contracts";
import { isConfigured, writeDatabase } from "@loom/db-exasol";
import { createRequest, details, snapshot } from "../apps/web/server/desk";
import {
  generateToolDraft,
  publishTool,
  toolWorkspace,
} from "../apps/web/server/tools";
import { toolModelConfiguration } from "../apps/web/server/tool-generation";

if (!isConfigured())
  throw new Error("Configure Exasol and apply migrations before tool:check.");
toolModelConfiguration();
const workspaceId = randomUUID();
const owner: Actor = { workspaceId, userId: randomUUID() };
const requester: Actor = { workspaceId, userId: randomUUID() };

try {
  await writeDatabase(async (sql) => {
    await sql.execute("INSERT INTO WORKSPACES (ID,NAME) VALUES (?,?)", [
      workspaceId,
      "Live tool designer synthetic check",
    ]);
    for (const [actor, role] of [
      [owner, "owner"],
      [requester, "requester"],
    ] as const)
      await sql.execute(
        "INSERT INTO MEMBERSHIPS (WORKSPACE_ID,USER_ID,NAME,ROLE,ACTIVE) VALUES (?,?,?,?,TRUE)",
        [workspaceId, actor.userId, `Synthetic ${role}`, role],
      );
  });
  const first = await generateToolDraft(
    owner,
    randomUUID(),
    1,
    [
      'Build a facilities request desk titled exactly "Facilities requests".',
      "Keep the existing description, four core fields, actions, filters, summary metrics, and status labels unchanged.",
      "Add one optional visible text field with ID custom_location, label Location, and maxLength 160.",
      "Keep the current queue columns in their exact order, then append custom_location.",
      "Return meaningful assumptions. No external integrations are requested.",
    ].join(" "),
    dataRequestTemplate,
  );
  const location = first.spec.fields.find(
    (field) => field.id === "custom_location",
  );
  assert.deepEqual(location, {
    id: "custom_location",
    label: "Location",
    type: "text",
    requiredAt: "optional",
    maxLength: 160,
    visible: true,
  });
  assert.equal(first.spec.title, "Facilities requests");
  assert.equal(
    (await toolWorkspace(owner)).published.revision,
    1,
    "Generation must not publish automatically.",
  );
  const published = await publishTool(
    owner,
    randomUUID(),
    first.id,
    1,
    first.hash,
  );
  const record = await createRequest(
    requester,
    randomUUID(),
    {
      title: "Repair a meeting-room light",
      businessQuestion:
        "Which maintenance visit can repair the synthetic meeting-room light?",
      reportingPeriod: "Next working day",
      dataset: "Building maintenance",
      customValues: { custom_location: "Room 42" },
    },
    published.revision,
  );

  const refineId = randomUUID();
  const instructions = [
    "Preserve the current tool exactly, including title, all existing fields with their exact descriptors and order, filters, summary metrics, actions and status labels.",
    "Add one optional visible text field with ID custom_asset_tag, label Asset tag, and maxLength 100.",
    "Keep the current queue columns in their exact order, then append custom_asset_tag. Do not remove custom_location.",
    "Describe the added field in assumptions. No external integrations are requested.",
  ].join(" ");
  const refined = await generateToolDraft(
    owner,
    refineId,
    published.revision,
    instructions,
    published.spec,
  );
  assert.deepEqual(
    refined.spec.fields.slice(0, published.spec.fields.length),
    published.spec.fields,
    "Refinement must preserve existing field descriptors and order.",
  );
  assert.deepEqual(
    refined.spec.fields.find((field) => field.id === "custom_asset_tag"),
    {
      id: "custom_asset_tag",
      label: "Asset tag",
      type: "text",
      requiredAt: "optional",
      maxLength: 100,
      visible: true,
    },
  );
  const replay = await generateToolDraft(
    owner,
    refineId,
    published.revision,
    instructions,
    published.spec,
  );
  assert.equal(
    replay.id,
    refined.id,
    "An acknowledged generation must replay its saved draft.",
  );
  const final = await publishTool(
    owner,
    randomUUID(),
    refined.id,
    published.revision,
    refined.hash,
  );
  const saved = await details(requester, record.id);
  assert.deepEqual(saved.request.customValues, { custom_location: "Room 42" });
  assert.equal(
    saved.request.version,
    record.version,
    "Tool publication must not rewrite request records.",
  );
  assert.equal((await snapshot(requester)).tool?.revision, final.revision);
  console.log(
    JSON.stringify(
      {
        ok: true,
        revision: final.revision,
        customFields: final.spec.fields
          .filter((field) => field.id.startsWith("custom_"))
          .map((field) => field.id),
        recordPreserved: true,
        initial: first.inference,
        refinement: refined.inference,
      },
      null,
      2,
    ),
  );
} finally {
  // Delete only this invocation's UUID workspace, including failed generations.
  await writeDatabase(async (sql) => {
    for (const table of [
      "TOOL_GENERATIONS",
      "TOOL_EVENTS",
      "TOOL_REVISIONS",
      "TOOL_DRAFTS",
      "TOOLS",
      "COMMENTS",
      "REQUEST_EVENTS",
      "AUDIT_EVENTS",
      "OUTBOX_EVENTS",
      "COMMAND_RECEIPTS",
      "REQUESTS",
      "MEMBERSHIPS",
      "WORKSPACES",
    ])
      await sql.execute(
        `DELETE FROM ${table} WHERE ${table === "WORKSPACES" ? "ID" : "WORKSPACE_ID"} = ?`,
        [workspaceId],
      );
  });
}
