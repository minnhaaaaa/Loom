import "server-only";
import { workspaceProvider, assertProviderCurrent } from "./provider-config";
import { modelIdentity } from "./provider-transport";
import {
  assertOpenAiPlanCurrent,
  readOpenAiPlanStatus,
  invalidateOpenAiPlanCredential,
  type OpenAiPlanStatus,
} from "./openai-oauth-store";
import { personalPlanModel, personalPlanRuntime } from "./personal-plan";
import { settingsFor } from "./settings";
import { randomUUID } from "node:crypto";
import {
  toolSpecSchema,
  toolCompatibilityErrors,
  type Actor,
  type ToolSpec,
  type ToolDraft,
  type PublishedTool,
  type ToolWorkspace,
  type ModelInference,
} from "@loom/contracts";
import { DomainError } from "@loom/domain";
import {
  fromTimestamp,
  readDatabase,
  sqlTimestamp,
  writeDatabase,
  type Row,
  type SqlSession,
} from "@loom/db-exasol";
import { digest, membership, receipt } from "./desk";
import { mapPublishedTool, publishedTool } from "./tool-definitions";
import {
  generateDefinition,
  toolModelConfiguration,
  toolGenerationPromptVersion,
} from "./tool-generation";

async function owner(sql: SqlSession, actor: Actor) {
  const member = await membership(sql, actor);
  if (member.role !== "owner")
    throw new DomainError(
      "ACCESS_DENIED",
      "Only a workspace owner can design or publish tools.",
      403,
    );
  return member;
}
function assertRevision(actual: number, expected: number) {
  if (actual !== expected)
    throw new DomainError(
      "TOOL_REVISION_CONFLICT",
      "The published tool changed. Refresh it and review a new draft before publishing.",
      409,
    );
}
const draftSelect =
  "SELECT D.*,G.INFERENCE_JSON AS GENERATION_INFERENCE_JSON FROM TOOL_DRAFTS D LEFT JOIN TOOL_GENERATIONS G ON G.WORKSPACE_ID=D.WORKSPACE_ID AND G.DRAFT_ID=D.ID AND G.LIFECYCLE='complete'";
function mapDraft(row: Row): ToolDraft {
  const draft: ToolDraft = {
    id: String(row.ID),
    baseRevision: Number(row.BASE_REVISION),
    spec: toolSpecSchema.parse(JSON.parse(String(row.SPEC_JSON))),
    instructions: String(row.INSTRUCTIONS ?? ""),
    assumptions: JSON.parse(String(row.ASSUMPTIONS_JSON)) as string[],
    unsupported: JSON.parse(String(row.UNSUPPORTED_JSON)) as string[],
    hash: String(row.CONTENT_HASH),
    createdAt: fromTimestamp(row.CREATED_AT),
    ...(row.GENERATION_INFERENCE_JSON
      ? {
          inference: JSON.parse(
            String(row.GENERATION_INFERENCE_JSON),
          ) as ModelInference,
        }
      : {}),
  };
  if (draft.hash !== draftDigest(draft))
    throw new DomainError(
      "TOOL_INTEGRITY",
      "The saved draft failed its integrity check.",
      409,
    );
  return draft;
}
function draftDigest(
  draft: Pick<
    ToolDraft,
    "baseRevision" | "spec" | "instructions" | "assumptions" | "unsupported"
  >,
) {
  return digest({
    baseRevision: draft.baseRevision,
    spec: draft.spec,
    instructions: draft.instructions,
    assumptions: draft.assumptions,
    unsupported: draft.unsupported,
  });
}
// Internal callers must authorize the actor within this transaction first.
export async function getDraft(sql: SqlSession, actor: Actor, id: string) {
  const [row] = await sql.query(
    `${draftSelect} WHERE D.WORKSPACE_ID = ? AND D.ID = ?`,
    [actor.workspaceId, id],
  );
  if (!row) throw new DomainError("NOT_FOUND", "Tool draft not found.", 404);
  return mapDraft(row);
}
async function getRevision(sql: SqlSession, actor: Actor, revision: number) {
  const [row] = await sql.query(
    "SELECT REVISION,SPEC_JSON,SPEC_HASH,PUBLISHED_AT FROM TOOL_REVISIONS WHERE WORKSPACE_ID = ? AND REVISION = ?",
    [actor.workspaceId, revision],
  );
  if (!row)
    throw new DomainError(
      "NOT_FOUND",
      "Published tool revision not found.",
      404,
    );
  return mapPublishedTool(row);
}
async function saveReceipt(
  sql: SqlSession,
  actor: Actor,
  commandId: string,
  hash: string,
  result: unknown,
) {
  await sql.execute(
    "INSERT INTO COMMAND_RECEIPTS (WORKSPACE_ID,COMMAND_ID,ACTOR_ID,PAYLOAD_HASH,RESULT_JSON,CREATED_AT) VALUES (?,?,?,?,?,?)",
    [
      actor.workspaceId,
      commandId,
      actor.userId,
      hash,
      JSON.stringify(result),
      sqlTimestamp(new Date().toISOString()),
    ],
  );
}
async function event(
  sql: SqlSession,
  actor: Actor,
  commandId: string,
  action: string,
  revision: number,
  draftId: string | null,
) {
  await sql.execute(
    "INSERT INTO TOOL_EVENTS (WORKSPACE_ID,ID,ACTOR_ID,COMMAND_ID,ACTION_KIND,REVISION,DRAFT_ID,CREATED_AT) VALUES (?,?,?,?,?,?,?,?)",
    [
      actor.workspaceId,
      randomUUID(),
      actor.userId,
      commandId,
      action,
      revision,
      draftId,
      sqlTimestamp(new Date().toISOString()),
    ],
  );
}
// Internal callers must authorize and validate revision/compatibility first.
export async function insertDraft(
  sql: SqlSession,
  actor: Actor,
  commandId: string,
  values: Pick<
    ToolDraft,
    "baseRevision" | "spec" | "instructions" | "assumptions" | "unsupported"
  >,
): Promise<ToolDraft> {
  if (
    JSON.stringify(values.spec).length > 100_000 ||
    JSON.stringify(values.assumptions).length > 20_000 ||
    JSON.stringify(values.unsupported).length > 20_000 ||
    values.instructions.length > 4000
  )
    throw new DomainError(
      "TOOL_DRAFT_LIMIT",
      "The tool draft exceeds its saved-content limits. Shorten the description or generated explanations.",
      422,
    );
  const draft: ToolDraft = {
    ...values,
    id: randomUUID(),
    hash: draftDigest(values),
    createdAt: new Date().toISOString(),
  };
  await sql.execute(
    "INSERT INTO TOOL_DRAFTS (WORKSPACE_ID,ID,BASE_REVISION,SPEC_JSON,INSTRUCTIONS,ASSUMPTIONS_JSON,UNSUPPORTED_JSON,CONTENT_HASH,CREATED_BY,CREATED_AT) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [
      actor.workspaceId,
      draft.id,
      draft.baseRevision,
      JSON.stringify(draft.spec),
      draft.instructions || null,
      JSON.stringify(draft.assumptions),
      JSON.stringify(draft.unsupported),
      draft.hash,
      actor.userId,
      sqlTimestamp(draft.createdAt),
    ],
  );
  await event(
    sql,
    actor,
    commandId,
    "tool_drafted",
    draft.baseRevision,
    draft.id,
  );
  return draft;
}
async function configuration(
  sql: SqlSession,
  actor: Actor,
): Promise<ToolWorkspace["configuration"]> {
  try {
    if ((await settingsFor(sql, actor)).preferredAgent === "codex") {
      const plan = await readOpenAiPlanStatus(sql, actor);
      return {
        configured: Boolean(plan?.planEnabled && plan.model),
        model: plan ? personalPlanModel(plan) : null,
        freeOnly: false,
        message:
          plan?.planEnabled && plan.model
            ? "Using ChatGPT plan. Generated drafts need your review before publication."
            : "Connect your ChatGPT account and choose a model in Company setup. Manual editing remains available.",
      };
    }
    const value =
      (await workspaceProvider(sql, actor)) || toolModelConfiguration();
    return {
      configured: true,
      model: modelIdentity(value),
      freeOnly: value.freeOnly,
      message: "",
    };
  } catch (error) {
    return {
      configured: false,
      model: null,
      message:
        error instanceof DomainError
          ? error.message
          : "Model generation is unavailable.",
    };
  }
}
export async function toolWorkspace(actor: Actor): Promise<ToolWorkspace> {
  return readDatabase(async (sql) => {
    const member = await membership(sql, actor),
      published = await publishedTool(sql, actor);
    if (member.role !== "owner")
      return {
        published,
        drafts: [],
        history: [],
        configuration: {
          configured: false,
          model: null,
          message: "Tool design is available to workspace owners.",
        },
      };
    const drafts = await sql.query(
      `${draftSelect} WHERE D.WORKSPACE_ID = ? ORDER BY D.CREATED_AT DESC,D.ID LIMIT 20`,
      [actor.workspaceId],
    );
    const revisions = await sql.query(
      "SELECT REVISION,SPEC_JSON,SPEC_HASH,PUBLISHED_AT FROM TOOL_REVISIONS WHERE WORKSPACE_ID = ? ORDER BY REVISION DESC LIMIT 20",
      [actor.workspaceId],
    );
    return {
      published,
      drafts: drafts.map(mapDraft),
      history: revisions.length ? revisions.map(mapPublishedTool) : [published],
      configuration: await configuration(sql, actor),
    };
  });
}
export async function createToolDraft(
  actor: Actor,
  commandId: string,
  expectedRevision: number,
  input: ToolSpec,
  instructions = "",
) {
  const spec = toolSpecSchema.parse(input),
    hash = digest({ type: "tool-draft", expectedRevision, spec, instructions });
  return writeDatabase(async (sql) => {
    await owner(sql, actor);
    const saved = await receipt<{ draftId: string }>(
      sql,
      actor,
      commandId,
      hash,
    );
    if (saved) return getDraft(sql, actor, saved.draftId);
    assertRevision(
      (await publishedTool(sql, actor)).revision,
      expectedRevision,
    );
    const draft = await insertDraft(sql, actor, commandId, {
      baseRevision: expectedRevision,
      spec,
      instructions,
      assumptions: [],
      unsupported: [],
    });
    await saveReceipt(sql, actor, commandId, hash, { draftId: draft.id });
    return draft;
  });
}
export async function publishTool(
  actor: Actor,
  commandId: string,
  draftId: string,
  expectedRevision: number,
  draftHash: string,
): Promise<PublishedTool> {
  const hash = digest({
    type: "tool-publish",
    draftId,
    expectedRevision,
    draftHash,
  });
  return writeDatabase(async (sql) => {
    await owner(sql, actor);
    const saved = await receipt<{ revision: number }>(
      sql,
      actor,
      commandId,
      hash,
    );
    if (saved) return getRevision(sql, actor, saved.revision);
    const current = await publishedTool(sql, actor),
      draft = await getDraft(sql, actor, draftId);
    assertRevision(current.revision, expectedRevision);
    assertRevision(draft.baseRevision, expectedRevision);
    if (draft.hash !== draftHash)
      throw new DomainError(
        "DRAFT_CONFLICT",
        "Review the exact saved draft before publishing.",
        409,
      );
    const errors = toolCompatibilityErrors(current.spec, draft.spec);
    if (errors.length)
      throw new DomainError("INCOMPATIBLE_TOOL", errors.join(" "), 422);
    if (digest(current.spec) === digest(draft.spec))
      throw new DomainError(
        "NO_TOOL_CHANGES",
        "This draft matches the published tool. Make a change before publishing.",
        422,
      );
    const revision = current.revision + 1,
      publishedAt = new Date().toISOString();
    if (current.revision === 1 && !current.publishedAt) {
      await sql.execute(
        "INSERT INTO TOOL_REVISIONS (WORKSPACE_ID,REVISION,SPEC_JSON,SPEC_HASH,DRAFT_ID,PUBLISHED_BY,PUBLISHED_AT) VALUES (?,1,?,?,NULL,NULL,NULL)",
        [actor.workspaceId, JSON.stringify(current.spec), digest(current.spec)],
      );
      await sql.execute(
        "INSERT INTO TOOLS (WORKSPACE_ID,CURRENT_REVISION) VALUES (?,1)",
        [actor.workspaceId],
      );
    }
    await sql.execute(
      "INSERT INTO TOOL_REVISIONS (WORKSPACE_ID,REVISION,SPEC_JSON,SPEC_HASH,DRAFT_ID,PUBLISHED_BY,PUBLISHED_AT) VALUES (?,?,?,?,?,?,?)",
      [
        actor.workspaceId,
        revision,
        JSON.stringify(draft.spec),
        digest(draft.spec),
        draft.id,
        actor.userId,
        sqlTimestamp(publishedAt),
      ],
    );
    const changed = await sql.execute(
      "UPDATE TOOLS SET CURRENT_REVISION = ? WHERE WORKSPACE_ID = ? AND CURRENT_REVISION = ?",
      [revision, actor.workspaceId, expectedRevision],
    );
    if (changed !== 1)
      throw new DomainError(
        "TOOL_REVISION_CONFLICT",
        "The tool changed during publication. Refresh and review again.",
        409,
      );
    await event(sql, actor, commandId, "tool_published", revision, draft.id);
    await saveReceipt(sql, actor, commandId, hash, { revision });
    return { revision, spec: draft.spec, publishedAt };
  });
}
export async function generateToolDraft(
  actor: Actor,
  commandId: string,
  expectedRevision: number,
  instructions: string,
  input: ToolSpec,
  personalPlan?: OpenAiPlanStatus,
): Promise<ToolDraft> {
  const baseSpec = toolSpecSchema.parse(input),
    hash = digest({
      type: "tool-generate",
      expectedRevision,
      instructions,
      baseSpec,
    });
  // Reserve a bounded attempt durably, then release the write coordinator before inference.
  const reservation = await writeDatabase(async (sql) => {
    await owner(sql, actor);
    const saved = await receipt<{ draftId: string }>(
      sql,
      actor,
      commandId,
      hash,
    );
    if (saved) return { draft: await getDraft(sql, actor, saved.draftId) };
    const current = await publishedTool(sql, actor);
    assertRevision(current.revision, expectedRevision);
    const baseErrors = toolCompatibilityErrors(current.spec, baseSpec);
    if (baseErrors.length)
      throw new DomainError(
        "INCOMPATIBLE_TOOL_BASE",
        baseErrors.join(" "),
        422,
      );
    if (
      !personalPlan &&
      (await settingsFor(sql, actor)).preferredAgent === "codex"
    ) {
      personalPlan = (await readOpenAiPlanStatus(sql, actor)) || undefined;
      if (!personalPlan?.planEnabled || !personalPlan.model)
        throw new DomainError(
          "OPENAI_PLAN_NOT_AUTHORIZED",
          "Connect your ChatGPT account and choose a model in Company setup. No API provider was used.",
          409,
        );
    }
    if (personalPlan) await assertOpenAiPlanCurrent(sql, actor, personalPlan);
    const runtimeConfig = personalPlan
      ? null
      : await workspaceProvider(sql, actor);
    const configuredModel = personalPlan
      ? personalPlanModel(personalPlan)
      : modelIdentity(runtimeConfig || toolModelConfiguration());
    if (!configuredModel)
      throw new DomainError(
        "MODEL_CONFIGURATION",
        "Choose a ChatGPT model in Company setup before generating a draft.",
        503,
      );
    const [existing] = await sql.query(
      "SELECT * FROM TOOL_GENERATIONS WHERE WORKSPACE_ID = ? AND COMMAND_ID = ?",
      [actor.workspaceId, commandId],
    );
    const now = new Date().toISOString(),
      leaseId = randomUUID(),
      leaseUntil = new Date(Date.now() + 120_000).toISOString();
    if (existing) {
      if (existing.ACTOR_ID !== actor.userId || existing.PAYLOAD_HASH !== hash)
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          "This command ID was already used for a different action.",
          409,
        );
      if (existing.LIFECYCLE === "complete" && existing.DRAFT_ID)
        return { draft: await getDraft(sql, actor, String(existing.DRAFT_ID)) };
      if (
        existing.LIFECYCLE === "running" &&
        fromTimestamp(existing.LEASE_UNTIL) > now
      )
        throw new DomainError(
          "GENERATION_IN_PROGRESS",
          "This generation is still running. Wait before retrying the same action.",
          409,
        );
      const retryAfterSeconds =
        existing.LIFECYCLE === "failed"
          ? Math.ceil(
              (Date.parse(fromTimestamp(existing.LEASE_UNTIL)) - Date.now()) /
                1000,
            )
          : 0;
      if (retryAfterSeconds > 0)
        throw new DomainError(
          "MODEL_HTTP_429",
          "Generation is cooling down after a provider limit. Wait before retrying the same action; your draft is preserved.",
          429,
          { retryAfterSeconds, retryable: true },
        );
      if (Number(existing.ATTEMPTS) >= 2)
        throw new DomainError(
          "GENERATION_RETRY_LIMIT",
          "This generation used its two attempts. Review the error before starting a new generation.",
          409,
        );
      const pinned = existing.INFERENCE_JSON
        ? (JSON.parse(String(existing.INFERENCE_JSON)) as {
            requestedModel?: string;
            promptVersion?: string;
          })
        : {};
      if (
        pinned.requestedModel !== configuredModel ||
        pinned.promptVersion !== toolGenerationPromptVersion
      )
        throw new DomainError(
          "MODEL_CONFIGURATION_CHANGED",
          "The model or tool-generation prompt changed. Start a new generation instead of retrying this saved attempt.",
          409,
        );
      await sql.execute(
        "UPDATE TOOL_GENERATIONS SET LIFECYCLE='running',ATTEMPTS=ATTEMPTS+1,LEASE_ID=?,LEASE_UNTIL=?,ERROR_CODE=NULL WHERE WORKSPACE_ID=? AND COMMAND_ID=?",
        [leaseId, sqlTimestamp(leaseUntil), actor.workspaceId, commandId],
      );
    } else {
      await sql.execute(
        "INSERT INTO TOOL_GENERATIONS (WORKSPACE_ID,COMMAND_ID,ACTOR_ID,PAYLOAD_HASH,BASE_REVISION,LIFECYCLE,ATTEMPTS,LEASE_ID,LEASE_UNTIL,INFERENCE_JSON,CREATED_AT) VALUES (?,?,?,?,?,'running',1,?,?,?,?)",
        [
          actor.workspaceId,
          commandId,
          actor.userId,
          hash,
          expectedRevision,
          leaseId,
          sqlTimestamp(leaseUntil),
          JSON.stringify({
            requestedModel: configuredModel,
            promptVersion: toolGenerationPromptVersion,
          }),
          sqlTimestamp(now),
        ],
      );
    }
    return { leaseId, model: configuredModel, runtimeConfig };
  });
  if (reservation.draft) return reservation.draft;
  try {
    const runtimeConfig = personalPlan
      ? await personalPlanRuntime(actor, personalPlan)
      : reservation.runtimeConfig;
    const result = await generateDefinition(
      instructions,
      baseSpec,
      reservation.model,
      runtimeConfig || undefined,
    );
    return await writeDatabase(async (sql) => {
      if (personalPlan) await assertOpenAiPlanCurrent(sql, actor, personalPlan);
      else await assertProviderCurrent(sql, actor, reservation.runtimeConfig);
      await owner(sql, actor);
      const current = await publishedTool(sql, actor);
      assertRevision(current.revision, expectedRevision);
      const [attempt] = await sql.query(
        "SELECT LEASE_ID,LIFECYCLE,LEASE_UNTIL FROM TOOL_GENERATIONS WHERE WORKSPACE_ID=? AND COMMAND_ID=?",
        [actor.workspaceId, commandId],
      );
      if (
        !attempt ||
        attempt.LEASE_ID !== reservation.leaseId ||
        attempt.LIFECYCLE !== "running" ||
        fromTimestamp(attempt.LEASE_UNTIL) <= new Date().toISOString()
      )
        throw new DomainError(
          "GENERATION_EXPIRED",
          "This generation attempt expired. Its output was discarded.",
          409,
        );
      const compatibilityErrors = [
        ...new Set([
          ...toolCompatibilityErrors(current.spec, result.spec),
          ...toolCompatibilityErrors(baseSpec, result.spec),
        ]),
      ];
      if (compatibilityErrors.length)
        throw new DomainError(
          "MODEL_OUTPUT_INCOMPATIBLE",
          `The generated draft would discard or incompatibly change existing fields. ${compatibilityErrors.join(" ")} Refine the request to preserve existing field IDs, types, and supported limits.`,
          422,
        );
      const draft = await insertDraft(sql, actor, commandId, {
        baseRevision: expectedRevision,
        spec: result.spec,
        instructions,
        assumptions: result.assumptions,
        unsupported: result.unsupported,
      });
      await sql.execute(
        "UPDATE TOOL_GENERATIONS SET LIFECYCLE='complete',DRAFT_ID=?,INFERENCE_JSON=? WHERE WORKSPACE_ID=? AND COMMAND_ID=? AND LEASE_ID=?",
        [
          draft.id,
          JSON.stringify(result.inference),
          actor.workspaceId,
          commandId,
          reservation.leaseId,
        ],
      );
      await saveReceipt(sql, actor, commandId, hash, { draftId: draft.id });
      return { ...draft, inference: result.inference };
    });
  } catch (error) {
    // Never retain model output after permission/revision changes. Failed attempts
    // still count: a lost provider acknowledgement may have been billable.
    if (
      personalPlan &&
      error instanceof DomainError &&
      error.code === "OPENAI_RECONNECT_REQUIRED"
    )
      await invalidateOpenAiPlanCredential(actor, personalPlan);
    const retryDelay =
      error instanceof DomainError
        ? error.details?.retryAfterSeconds
        : undefined;
    const retryUntil = new Date(
      Date.now() +
        (retryDelay !== undefined &&
        Number.isFinite(retryDelay) &&
        retryDelay > 0
          ? retryDelay * 1000
          : 0),
    ).toISOString();
    await writeDatabase(async (sql) => {
      await sql.execute(
        "UPDATE TOOL_GENERATIONS SET LIFECYCLE='failed',ERROR_CODE=?,LEASE_UNTIL=? WHERE WORKSPACE_ID=? AND COMMAND_ID=? AND ACTOR_ID=? AND LEASE_ID=? AND LIFECYCLE='running'",
        [
          error instanceof DomainError ? error.code : "GENERATION_FAILED",
          sqlTimestamp(retryUntil),
          actor.workspaceId,
          commandId,
          actor.userId,
          reservation.leaseId,
        ],
      );
    }).catch(() => undefined);
    throw error;
  }
}
