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
} from "@loom/contracts";
import { activeKnowledge, DomainError, triageRequest } from "@loom/domain";
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
  routingCandidates,
  routingDigest,
  saveReceipt,
} from "./knowledge";
function mapRun(row: Row): TriageRun {
  return {
    id: String(row.ID),
    workspaceId: String(row.WORKSPACE_ID),
    initiatorId: String(row.INITIATOR_ID),
    requestIds: JSON.parse(String(row.REQUEST_IDS_JSON)),
    engine: row.ENGINE as TriageRun["engine"],
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
  if (run.engine !== "rules-v1" || run.toolRevision !== "request-desk-v1")
    throw new DomainError(
      "UNSUPPORTED_RUN",
      "This run requires an unsupported engine or tool revision.",
      409,
    );
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
    return { runs: rows.map(mapRun) };
  });
}
export async function startRun(
  actor: Actor,
  commandId: string,
  requestIds: string[],
) {
  runStartSchema.parse({ commandId, requestIds });
  const hash = digest({ type: "triage-start", requestIds });
  return writeDatabase(async (sql) => {
    const member = await requireOperator(sql, actor);
    const existing = await receipt<{ id: string }>(sql, actor, commandId, hash);
    if (existing) return getRun(sql, actor, existing.id);
    for (const id of requestIds) await getRequest(sql, actor, member, id);
    const id = randomUUID(),
      now = new Date().toISOString(),
      expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    await sql.execute(
      "INSERT INTO AGENT_RUNS (WORKSPACE_ID,ID,INITIATOR_ID,REQUEST_IDS_JSON,STATUS,VERSION,CHECKPOINT,CREATED_AT,EXPIRES_AT,ENGINE,TOOL_REVISION) VALUES (?,?,?,?,'queued',1,0,?,?,'rules-v1','request-desk-v1')",
      [
        actor.workspaceId,
        id,
        actor.userId,
        JSON.stringify(requestIds),
        sqlTimestamp(now),
        sqlTimestamp(expiresAt),
      ],
    );
    await agentEvent(sql, actor, id, "triage_started", 1);
    await saveReceipt(sql, actor, commandId, hash, { id });
    return getRun(sql, actor, id);
  });
}
export async function changeRun(
  actor: Actor,
  id: string,
  commandId: string,
  expectedVersion: number,
  action: "advance" | "cancel",
) {
  const hash = digest({ type: "triage-step", id, expectedVersion, action });
  return writeDatabase(async (sql) => {
    const run = await getRun(sql, actor, id);
    const actorMember = await requireOperator(sql, actor);
    if (run.initiatorId !== actor.userId && actorMember.role !== "owner")
      throw new DomainError(
        "ACCESS_DENIED",
        "Only the initiator or a workspace owner can advance or cancel this run.",
        403,
      );
    if (await receipt(sql, actor, commandId, hash))
      return runDetails(sql, actor, id);
    if (run.version !== expectedVersion)
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
    let status: TriageRun["status"] =
        action === "cancel" ? "cancelled" : "running",
      checkpoint = run.checkpoint;
    if (new Date().toISOString() >= run.expiresAt) status = "timed_out";
    else if (action === "advance") {
      const member = await requireOperator(sql, actor);
      const request = await getRequest(
        sql,
        actor,
        member,
        run.requestIds[checkpoint],
      );
      const candidates = await routingCandidates(sql, actor, request.dataset);
      const suggestion = triageRequest(
        request,
        candidates,
        await membersFor(sql, actor),
        new Date().toISOString().slice(0, 10),
      );
      let proposalId: string | null = null;
      if (suggestion.commands.length) {
        proposalId = randomUUID();
        const content: ProposalContent = {
          workspaceId: actor.workspaceId,
          runId: run.id,
          id: proposalId,
          revision: 1,
          initiatorId: run.initiatorId,
          engine: "rules-v1",
          toolRevision: "request-desk-v1",
          requestId: request.id,
          expectedVersion: request.version,
          before: request,
          commands: suggestion.commands,
          after: suggestion.after,
          evidence: suggestion.evidence.map((entry) => ({
            id: entry.id,
            version: entry.version,
            contentHash: entry.contentHash,
            title: entry.title,
          })),
          routingDigest: routingDigest(candidates),
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
            request.id,
            JSON.stringify(content),
            digest(content),
          ],
        );
        await agentEvent(sql, actor, proposalId, "proposal_created", 1);
      }
      const step: TriageStep = {
        index: checkpoint,
        requestId: request.id,
        requestVersion: request.version,
        summary: suggestion.reasons.join(" ") || "No changes proposed.",
        uncertainty: suggestion.uncertainty,
        proposalId,
      };
      await sql.execute(
        "INSERT INTO AGENT_STEPS (WORKSPACE_ID,RUN_ID,STEP_INDEX,REQUEST_ID,REQUEST_VERSION,OUTPUT_JSON,PROPOSAL_ID) VALUES (?,?,?,?,?,?,?)",
        [
          actor.workspaceId,
          id,
          checkpoint,
          request.id,
          request.version,
          JSON.stringify(step),
          proposalId,
        ],
      );
      checkpoint++;
      if (checkpoint === run.requestIds.length) status = "completed";
    }
    const changed = await sql.execute(
      "UPDATE AGENT_RUNS SET STATUS = ?,CHECKPOINT = ?,VERSION = VERSION + 1 WHERE WORKSPACE_ID = ? AND ID = ? AND VERSION = ?",
      [status, checkpoint, actor.workspaceId, id, expectedVersion],
    );
    if (changed !== 1)
      throw new DomainError(
        "VERSION_CONFLICT",
        "Run changed. Refresh before continuing.",
        409,
      );
    await agentEvent(sql, actor, id, `triage_${status}`, expectedVersion + 1);
    await saveReceipt(sql, actor, commandId, hash, { id });
    return runDetails(sql, actor, id);
  });
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
        content.engine !== "rules-v1" ||
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
      const candidates = await routingCandidates(sql, actor, next.dataset),
        members = await membersFor(sql, actor),
        today = new Date().toISOString().slice(0, 10);
      if (routingDigest(candidates) !== content.routingDigest)
        throw new DomainError(
          "STALE_KNOWLEDGE",
          "Routing knowledge changed after triage. Run triage again.",
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
      // Also catches newly effective rules, conflicting routes, and owner eligibility changes.
      if (
        digest(triageRequest(next, candidates, members, today).commands) !==
        digest(content.commands)
      )
        throw new DomainError(
          "STALE_PROPOSAL",
          "The current rules or eligible owners no longer support these actions. Run triage again.",
          409,
        );
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
