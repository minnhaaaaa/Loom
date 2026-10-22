import "server-only";
import { randomUUID } from "node:crypto";
import {
  type Actor,
  type ProposalContent,
  type RequestRecord,
  type RunDetails,
  type TriageProposal,
  type TriageRun,
  type TriageStep,
  runStartSchema,
  toolSpec,
  modelSuggestionSchema,
  type Membership,
  type KnowledgeEntry,
} from "@loom/contracts";
import {
  activeKnowledge,
  applyCommand,
  transitions,
  DomainError,
} from "@loom/domain";
import {
  fromTimestamp,
  readDatabase,
  sqlTimestamp,
  writeDatabase,
  type Row,
  type SqlSession,
} from "@loom/db-exasol";
import {
  applyRequestCommand,
  digest,
  getRequest,
  membersFor,
  receipt,
} from "./desk";
import {
  agentEvent,
  getKnowledge,
  requireOperator,
  approvedKnowledge,
  knowledgeDigest,
  saveReceipt,
} from "./knowledge";
import {
  inferProposal,
  modelConfiguration,
  promptVersion,
  type ModelResult,
} from "./openrouter";
function mapRun(row: Row): TriageRun {
  return {
    id: String(row.ID),
    workspaceId: String(row.WORKSPACE_ID),
    initiatorId: String(row.INITIATOR_ID),
    requestIds: JSON.parse(String(row.REQUEST_IDS_JSON)),
    engine: String(row.ENGINE),
    model: row.MODEL ? String(row.MODEL) : null,
    instructions: String(row.INSTRUCTIONS || ""),
    promptVersion: row.PROMPT_VERSION ? String(row.PROMPT_VERSION) : null,
    toolRevision: row.TOOL_REVISION as TriageRun["toolRevision"],
    status: row.STATUS as TriageRun["status"],
    version: Number(row.VERSION),
    checkpoint: Number(row.CHECKPOINT),
    createdAt: fromTimestamp(row.CREATED_AT),
    expiresAt: fromTimestamp(row.EXPIRES_AT),
  };
}
async function getRun(sql: SqlSession, actor: Actor, id: string) {
  await requireOperator(sql, actor);
  const [row] = await sql.query(
    "SELECT * FROM AGENT_RUNS WHERE WORKSPACE_ID = ? AND ID = ?",
    [actor.workspaceId, id],
  );
  if (!row) throw new DomainError("NOT_FOUND", "Triage run not found.", 404);
  const run = mapRun(row);
  await requireOperator(sql, { ...actor, userId: run.initiatorId });
  return run;
}
async function runDetails(
  sql: SqlSession,
  actor: Actor,
  id: string,
): Promise<RunDetails> {
  const run = await getRun(sql, actor, id);
  const steps = await sql.query(
    "SELECT OUTPUT_JSON FROM AGENT_STEPS WHERE WORKSPACE_ID = ? AND RUN_ID = ? ORDER BY STEP_INDEX LIMIT 20",
    [actor.workspaceId, id],
  );
  const proposals = await sql.query(
    "SELECT CONTENT_JSON,CONTENT_HASH,LIFECYCLE,REVIEWED_BY FROM TRIAGE_PROPOSALS WHERE WORKSPACE_ID = ? AND RUN_ID = ? ORDER BY ID LIMIT 20",
    [actor.workspaceId, id],
  );
  return {
    run,
    steps: steps.map(
      (row) => JSON.parse(String(row.OUTPUT_JSON)) as TriageStep,
    ),
    proposals: proposals.map((row) => ({
      content: JSON.parse(String(row.CONTENT_JSON)) as ProposalContent,
      hash: String(row.CONTENT_HASH),
      state: row.LIFECYCLE as TriageProposal["state"],
      reviewedBy: row.REVIEWED_BY ? String(row.REVIEWED_BY) : null,
    })),
  };
}
export function readRun(actor: Actor, id: string) {
  return readDatabase((sql) => runDetails(sql, actor, id));
}
export async function listRuns(actor: Actor) {
  return readDatabase(async (sql) => {
    await requireOperator(sql, actor);
    const rows = await sql.query(
      "SELECT * FROM AGENT_RUNS WHERE WORKSPACE_ID = ? AND INITIATOR_ID = ? ORDER BY CREATED_AT DESC,ID LIMIT 10",
      [actor.workspaceId, actor.userId],
    );
    let configuration;
    try {
      const config = modelConfiguration();
      configuration = { configured: true, model: config.model, message: "" };
    } catch (error) {
      configuration = {
        configured: false,
        model: null,
        message:
          error instanceof DomainError
            ? error.message
            : "Model configuration is invalid.",
      };
    }
    return { runs: rows.map(mapRun), configuration };
  });
}
export async function startRun(
  actor: Actor,
  commandId: string,
  requestIds: string[],
  instructions: string,
) {
  instructions = runStartSchema.parse({
    commandId,
    requestIds,
    instructions,
  }).instructions;
  const hash = digest({ type: "triage-start", requestIds, instructions });
  return writeDatabase(async (sql) => {
    const member = await requireOperator(sql, actor);
    const existing = await receipt<{ id: string }>(sql, actor, commandId, hash);
    if (existing) return getRun(sql, actor, existing.id);
    const config = modelConfiguration();
    for (const id of requestIds) await getRequest(sql, actor, member, id);
    const id = randomUUID(),
      now = new Date().toISOString(),
      expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    await sql.execute(
      "INSERT INTO AGENT_RUNS (WORKSPACE_ID,ID,INITIATOR_ID,REQUEST_IDS_JSON,STATUS,VERSION,CHECKPOINT,CREATED_AT,EXPIRES_AT,ENGINE,TOOL_REVISION,MODEL,INSTRUCTIONS,PROMPT_VERSION) VALUES (?,?,?,?,'queued',1,0,?,?,'openrouter-v1','request-desk-v1',?,?,?)",
      [
        actor.workspaceId,
        id,
        actor.userId,
        JSON.stringify(requestIds),
        sqlTimestamp(now),
        sqlTimestamp(expiresAt),
        config.model,
        instructions,
        promptVersion,
      ],
    );
    await agentEvent(sql, actor, id, "triage_started", 1);
    await saveReceipt(sql, actor, commandId, hash, { id });
    return getRun(sql, actor, id);
  });
}
function supportedRun(run: TriageRun) {
  if (
    run.engine !== "openrouter-v1" ||
    !run.model ||
    run.promptVersion !== promptVersion ||
    run.toolRevision !== "request-desk-v1"
  )
    throw new DomainError(
      "UNSUPPORTED_RUN",
      "This historical run is read-only. Start a new model-backed run.",
      409,
    );
}
async function contextFor(sql: SqlSession, actor: Actor, run: TriageRun) {
  const member = await requireOperator(sql, actor);
  const request = await getRequest(
    sql,
    actor,
    member,
    run.requestIds[run.checkpoint],
  );
  const knowledge = await approvedKnowledge(sql, actor),
    members = await membersFor(sql, actor);
  const comments = await sql.query(
    "SELECT BODY,VISIBILITY,AUTHOR_ID,CREATED_AT FROM COMMENTS WHERE WORKSPACE_ID = ? AND REQUEST_ID = ? ORDER BY CREATED_AT DESC,ID DESC LIMIT 21",
    [actor.workspaceId, request.id],
  );
  if (comments.length > 20)
    throw new DomainError(
      "MODEL_CONTEXT_LIMIT",
      "This request has more than 20 comments. A bounded conversation retrieval strategy is required before model triage.",
      422,
    );
  const context = {
    task: run.instructions,
    today: new Date().toISOString().slice(0, 10),
    request,
    comments,
    knowledge,
    members,
    tool: toolSpec,
    allowedTransitions: transitions,
    promptVersion,
  };
  if (Buffer.byteLength(JSON.stringify(context), "utf8") > 120_000)
    throw new DomainError(
      "MODEL_CONTEXT_LIMIT",
      "The model context exceeds 120 KB. Shorten the request or knowledge corpus before continuing.",
      422,
    );
  return context;
}
function validateSuggestion(
  result: ModelResult,
  request: RequestRecord,
  member: Membership,
  members: Membership[],
  knowledge: KnowledgeEntry[],
) {
  const suggestion = modelSuggestionSchema.parse(result.suggestion);
  if (
    new Set(suggestion.evidenceIds).size !== suggestion.evidenceIds.length ||
    suggestion.evidenceIds.some(
      (id) => !knowledge.some((entry) => entry.id === id),
    )
  )
    throw new DomainError(
      "MODEL_EVIDENCE_INVALID",
      "The model cited unavailable evidence. No proposal was saved.",
      502,
    );
  let after = request;
  try {
    for (const command of suggestion.commands)
      after = applyCommand(member, after, command, members);
  } catch {
    throw new DomainError(
      "MODEL_ACTION_INVALID",
      "The model proposed an action that violates current field, transition, or permission constraints. No proposal was saved.",
      502,
    );
  }
  return {
    suggestion,
    after,
    evidence: knowledge.filter((entry) =>
      suggestion.evidenceIds.includes(entry.id),
    ),
  };
}
const controllers = new Map<string, AbortController>();
export async function changeRun(
  actor: Actor,
  id: string,
  commandId: string,
  expectedVersion: number,
  action: "advance" | "cancel",
  signal?: AbortSignal,
): Promise<RunDetails> {
  const hash = digest({ type: "triage-step", id, expectedVersion, action });
  const reservation = await writeDatabase(async (sql) => {
    const run = await getRun(sql, actor, id),
      member = await requireOperator(sql, actor);
    if (run.initiatorId !== actor.userId && member.role !== "owner")
      throw new DomainError(
        "ACCESS_DENIED",
        "Only the initiator or a workspace owner can advance or cancel this run.",
        403,
      );
    if (await receipt(sql, actor, commandId, hash))
      return { cached: await runDetails(sql, actor, id) };
    const attempts = await sql.query(
      "SELECT * FROM MODEL_ATTEMPTS WHERE WORKSPACE_ID = ? AND RUN_ID = ? AND STEP_INDEX = ? ORDER BY ATTEMPT_NO",
      [actor.workspaceId, id, run.checkpoint],
    );
    const [sameCommand] = await sql.query(
      "SELECT * FROM MODEL_ATTEMPTS WHERE WORKSPACE_ID = ? AND COMMAND_ID = ? ORDER BY ATTEMPT_NO DESC LIMIT 1",
      [actor.workspaceId, commandId],
    );
    if (
      sameCommand &&
      (sameCommand.PAYLOAD_HASH !== hash ||
        sameCommand.ACTOR_ID !== actor.userId ||
        sameCommand.RUN_ID !== id ||
        Number(sameCommand.STEP_INDEX) !== run.checkpoint)
    )
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "This command ID was already used for a different action.",
        409,
      );
    if (run.version !== expectedVersion && !sameCommand)
      throw new DomainError(
        "VERSION_CONFLICT",
        "Run changed. Refresh its checkpoint before continuing.",
        409,
      );
    if (!["queued", "running"].includes(run.status))
      throw new DomainError(
        "RUN_TERMINAL",
        "This run has finished. Reject pending proposals or start a new run.",
        409,
      );
    if (action === "cancel" || run.expiresAt <= new Date().toISOString()) {
      const status = action === "cancel" ? "cancelled" : "timed_out";
      await sql.execute(
        "UPDATE AGENT_RUNS SET STATUS = ?,VERSION = VERSION + 1 WHERE WORKSPACE_ID = ? AND ID = ? AND VERSION = ?",
        [status, actor.workspaceId, id, run.version],
      );
      await agentEvent(sql, actor, id, `triage_${status}`, run.version + 1);
      await saveReceipt(sql, actor, commandId, hash, { id });
      return { cached: await runDetails(sql, actor, id) };
    }
    supportedRun(run);
    modelConfiguration();
    if (
      attempts.some(
        (attempt) =>
          attempt.LIFECYCLE === "pending" &&
          fromTimestamp(attempt.LEASE_UNTIL) > new Date().toISOString(),
      )
    )
      throw new DomainError(
        "STEP_IN_PROGRESS",
        "A model call is already processing this checkpoint. Refresh its saved state; do not submit another paid call yet.",
        409,
      );
    if (attempts.length >= 2)
      throw new DomainError(
        "MODEL_RETRY_LIMIT",
        "This checkpoint has used its two provider-call attempts. Inspect the errors and start a new run if needed.",
        409,
      );
    const context = await contextFor(sql, actor, run),
      attemptId = randomUUID(),
      leaseUntil = new Date(Date.now() + 120_000).toISOString();
    const changed = await sql.execute(
      "UPDATE AGENT_RUNS SET STATUS = 'running',VERSION = VERSION + 1 WHERE WORKSPACE_ID = ? AND ID = ? AND VERSION = ?",
      [actor.workspaceId, id, run.version],
    );
    if (changed !== 1)
      throw new DomainError(
        "VERSION_CONFLICT",
        "Run changed before inference. Refresh its saved state.",
        409,
      );
    await sql.execute(
      "INSERT INTO MODEL_ATTEMPTS (WORKSPACE_ID,ID,RUN_ID,STEP_INDEX,ATTEMPT_NO,COMMAND_ID,ACTOR_ID,PAYLOAD_HASH,INPUT_HASH,CONTEXT_JSON,LIFECYCLE,LEASE_UNTIL,RESULT_JSON,ERROR_CODE,CREATED_AT) VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,NULL,NULL,?)",
      [
        actor.workspaceId,
        attemptId,
        id,
        run.checkpoint,
        attempts.length + 1,
        commandId,
        actor.userId,
        hash,
        digest(context),
        JSON.stringify(context),
        sqlTimestamp(leaseUntil),
        sqlTimestamp(new Date().toISOString()),
      ],
    );
    await agentEvent(sql, actor, id, "model_call_reserved", run.version + 1);
    return { attemptId, run: { ...run, version: run.version + 1 }, context };
  });
  if ("cached" in reservation) {
    if (action === "cancel")
      controllers.get(`${actor.workspaceId}/${id}`)?.abort();
    return reservation.cached!;
  }
  const controller = new AbortController(),
    key = `${actor.workspaceId}/${id}`;
  controllers.set(key, controller);
  try {
    // No SQL connection, transaction, or write-coordinator slot is held during inference.
    const result = await inferProposal(
      reservation.context,
      reservation.run.model!,
      AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]),
    );
    return await writeDatabase(async (sql) => {
      const run = await getRun(sql, actor, id),
        member = await requireOperator(sql, actor);
      if (await receipt(sql, actor, commandId, hash))
        return runDetails(sql, actor, id);
      supportedRun(run);
      if (
        run.version !== reservation.run.version ||
        run.checkpoint !== reservation.run.checkpoint ||
        run.status !== "running" ||
        run.expiresAt <= new Date().toISOString()
      )
        throw new DomainError(
          "RUN_CHANGED",
          "The run changed, expired, or was cancelled during inference. Model output was discarded.",
          409,
        );
      const context = await contextFor(sql, actor, run);
      if (digest(context) !== digest(reservation.context))
        throw new DomainError(
          "STALE_CONTEXT",
          "The request, members, comments, or approved knowledge changed during inference. Model output was discarded; refresh and retry.",
          409,
        );
      const { suggestion, after, evidence } = validateSuggestion(
        result,
        context.request,
        member,
        context.members,
        context.knowledge,
      );
      let proposalId: string | null = null;
      if (suggestion.commands.length) {
        proposalId = randomUUID();
        const content: ProposalContent = {
          workspaceId: actor.workspaceId,
          runId: id,
          id: proposalId,
          revision: 1,
          initiatorId: run.initiatorId,
          engine: "openrouter-v1",
          inference: result.inference,
          toolRevision: "request-desk-v1",
          requestId: context.request.id,
          expectedVersion: context.request.version,
          before: context.request,
          commands: suggestion.commands,
          after,
          evidence: evidence.map((entry) => ({
            id: entry.id,
            version: entry.version,
            contentHash: entry.contentHash,
            title: entry.title,
          })),
          knowledgeDigest: knowledgeDigest(context.knowledge),
          reasons: suggestion.reasons,
          uncertainty: suggestion.uncertainty,
          expiresAt: run.expiresAt,
        };
        await sql.execute(
          "INSERT INTO TRIAGE_PROPOSALS (WORKSPACE_ID,ID,RUN_ID,REQUEST_ID,CONTENT_JSON,CONTENT_HASH,LIFECYCLE,REVIEWED_BY) VALUES (?,?,?,?,?,?,'pending',NULL)",
          [
            actor.workspaceId,
            proposalId,
            id,
            context.request.id,
            JSON.stringify(content),
            digest(content),
          ],
        );
        await agentEvent(sql, actor, proposalId, "proposal_created", 1);
      }
      const step: TriageStep = {
        index: run.checkpoint,
        requestId: context.request.id,
        requestVersion: context.request.version,
        summary: suggestion.summary,
        uncertainty: suggestion.uncertainty,
        proposalId,
        inference: result.inference,
      };
      await sql.execute(
        "INSERT INTO AGENT_STEPS (WORKSPACE_ID,RUN_ID,STEP_INDEX,REQUEST_ID,REQUEST_VERSION,OUTPUT_JSON,PROPOSAL_ID) VALUES (?,?,?,?,?,?,?)",
        [
          actor.workspaceId,
          id,
          run.checkpoint,
          context.request.id,
          context.request.version,
          JSON.stringify(step),
          proposalId,
        ],
      );
      await sql.execute(
        "UPDATE MODEL_ATTEMPTS SET LIFECYCLE = 'completed',RESULT_JSON = ? WHERE WORKSPACE_ID = ? AND ID = ?",
        [JSON.stringify(result), actor.workspaceId, reservation.attemptId],
      );
      const status =
        run.checkpoint + 1 === run.requestIds.length ? "completed" : "running";
      const advanced = await sql.execute(
        "UPDATE AGENT_RUNS SET STATUS = ?,CHECKPOINT = CHECKPOINT + 1,VERSION = VERSION + 1 WHERE WORKSPACE_ID = ? AND ID = ? AND VERSION = ?",
        [status, actor.workspaceId, id, run.version],
      );
      if (advanced !== 1)
        throw new DomainError(
          "VERSION_CONFLICT",
          "Run changed before checkpoint persistence.",
          409,
        );
      await agentEvent(sql, actor, id, `triage_${status}`, run.version + 1);
      await saveReceipt(sql, actor, commandId, hash, { id });
      return runDetails(sql, actor, id);
    });
  } catch (error) {
    // An unknown commit acknowledgement must leave a possibly completed attempt intact.
    await writeDatabase(async (sql) => {
      await sql.execute(
        "UPDATE MODEL_ATTEMPTS SET LIFECYCLE = 'failed',ERROR_CODE = ? WHERE WORKSPACE_ID = ? AND ID = ? AND LIFECYCLE = 'pending'",
        [
          error instanceof DomainError ? error.code : "MODEL_STEP_FAILED",
          actor.workspaceId,
          reservation.attemptId,
        ],
      );
    }).catch(() => undefined);
    throw error;
  } finally {
    if (controllers.get(key) === controller) controllers.delete(key);
  }
}
export async function reviewProposal(
  actor: Actor,
  id: string,
  commandId: string,
  proposalHash: string,
  action: "approve" | "reject",
) {
  const hash = digest({ type: "proposal-review", id, proposalHash, action });
  return writeDatabase(async (sql) => {
    const member = await requireOperator(sql, actor);
    const [row] = await sql.query(
      "SELECT * FROM TRIAGE_PROPOSALS WHERE WORKSPACE_ID = ? AND ID = ?",
      [actor.workspaceId, id],
    );
    if (!row) throw new DomainError("NOT_FOUND", "Proposal not found.", 404);
    const content = JSON.parse(String(row.CONTENT_JSON)) as ProposalContent;
    const run = await getRun(sql, actor, String(row.RUN_ID));
    if (row.CONTENT_HASH !== proposalHash || digest(content) !== proposalHash)
      throw new DomainError(
        "PROPOSAL_HASH",
        "Proposal content does not match the review. Refresh before reviewing.",
        409,
      );
    const existing = await receipt<{
      id: string;
      state: "applied" | "rejected";
      requestVersion: number | null;
    }>(sql, actor, commandId, hash);
    if (existing) return existing;
    if (row.LIFECYCLE !== "pending") {
      if (
        (action === "approve" && row.LIFECYCLE === "applied") ||
        (action === "reject" && row.LIFECYCLE === "rejected")
      ) {
        const result = {
          id,
          state: String(row.LIFECYCLE),
          requestVersion: action === "approve" ? content.after.version : null,
        };
        await saveReceipt(sql, actor, commandId, hash, result);
        return result;
      }
      throw new DomainError(
        "PROPOSAL_STATE",
        "This proposal has already been reviewed.",
        409,
      );
    }
    let next: RequestRecord | null = null;
    if (action === "approve") {
      if (
        run.status !== "completed" ||
        run.expiresAt <= new Date().toISOString() ||
        content.expiresAt <= new Date().toISOString()
      )
        throw new DomainError(
          "RUN_NOT_APPROVABLE",
          "Complete the run before approval. Cancelled or expired runs cannot apply changes.",
          409,
        );
      if (
        content.workspaceId !== actor.workspaceId ||
        content.runId !== run.id ||
        content.requestId !== row.REQUEST_ID ||
        content.id !== id ||
        content.engine !== "openrouter-v1" ||
        content.toolRevision !== "request-desk-v1" ||
        content.initiatorId !== run.initiatorId
      )
        throw new DomainError(
          "PROPOSAL_CONTEXT",
          "This proposal context is no longer supported.",
          409,
        );
      next = await getRequest(sql, actor, member, content.requestId);
      if (next.version !== content.expectedVersion)
        throw new DomainError(
          "STALE_PROPOSAL",
          "Request changed after triage. Reject this proposal and run triage again.",
          409,
        );
      supportedRun(run);
      const knowledge = await approvedKnowledge(sql, actor),
        today = new Date().toISOString().slice(0, 10);
      if (knowledgeDigest(knowledge) !== content.knowledgeDigest)
        throw new DomainError(
          "STALE_KNOWLEDGE",
          "Approved knowledge changed after inference. Run the model again.",
          409,
        );
      for (const dependency of content.evidence) {
        const entry = await getKnowledge(sql, actor, dependency.id);
        if (
          entry.version !== dependency.version ||
          entry.contentHash !== dependency.contentHash ||
          !activeKnowledge(entry, today)
        )
          throw new DomainError(
            "STALE_KNOWLEDGE",
            "Evidence is no longer active and approved. Run triage again.",
            409,
          );
      }
      for (const command of content.commands)
        next = await applyRequestCommand(
          sql,
          actor,
          member,
          next,
          commandId,
          hash,
          next.version,
          command,
          false,
        );
    }
    const state = action === "approve" ? "applied" : "rejected";
    const changed = await sql.execute(
      "UPDATE TRIAGE_PROPOSALS SET LIFECYCLE = ?,REVIEWED_BY = ? WHERE WORKSPACE_ID = ? AND ID = ? AND LIFECYCLE = 'pending'",
      [state, actor.userId, actor.workspaceId, id],
    );
    if (changed !== 1)
      throw new DomainError(
        "PROPOSAL_STATE",
        "Proposal changed. Refresh its saved state.",
        409,
      );
    await agentEvent(sql, actor, id, `proposal_${state}`, 1);
    const result = { id, state, requestVersion: next?.version ?? null };
    await saveReceipt(sql, actor, commandId, hash, result);
    return result;
  });
}
