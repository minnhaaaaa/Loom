import "server-only";
import { randomUUID } from "node:crypto";
import {
  knowledgeInputSchema,
  type Actor,
  type KnowledgeEntry,
  type KnowledgeInput,
  type KnowledgeProvenance,
  type ProposalContent,
  type ProposalKnowledgeInput,
  proposalKnowledgeSchema,
  type Membership,
} from "@loom/contracts";
import {
  canOperate,
  DomainError,
  activeKnowledge,
  knowledgeQueryTerms,
} from "@loom/domain";
import {
  fromTimestamp,
  readDatabase,
  sqlTimestamp,
  writeDatabase,
  type Row,
  type SqlSession,
} from "@loom/db-exasol";
import { digest, getRequest, membership, receipt } from "./desk";
import { publishedTool } from "./tool-definitions";
export async function requireOperator(sql: SqlSession, actor: Actor) {
  const member = await membership(sql, actor);
  if (!canOperate(member))
    throw new DomainError(
      "ACCESS_DENIED",
      "This action requires an owner or operator.",
      403,
    );
  return member;
}
export async function saveReceipt(
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
export async function agentEvent(
  sql: SqlSession,
  actor: Actor,
  resourceId: string,
  action: string,
  version: number,
) {
  await sql.execute(
    "INSERT INTO AGENT_EVENTS (WORKSPACE_ID,ID,RESOURCE_ID,ACTOR_ID,ACTION_KIND,VERSION,CREATED_AT) VALUES (?,?,?,?,?,?,?)",
    [
      actor.workspaceId,
      randomUUID(),
      resourceId,
      actor.userId,
      action,
      version,
      sqlTimestamp(new Date().toISOString()),
    ],
  );
}
function mapKnowledge(row: Row): KnowledgeEntry {
  const values = knowledgeInputSchema.parse(
    JSON.parse(String(row.CONTENT_JSON)),
  );
  if (digest(values) !== row.CONTENT_HASH)
    throw new DomainError(
      "KNOWLEDGE_INTEGRITY",
      "Knowledge content failed its integrity check.",
      409,
    );
  return {
    ...values,
    id: String(row.ID),
    workspaceId: String(row.WORKSPACE_ID),
    version: Number(row.VERSION),
    state: row.LIFECYCLE as KnowledgeEntry["state"],
    contentHash: String(row.CONTENT_HASH),
    createdBy: String(row.CREATED_BY),
    createdAt: fromTimestamp(row.CREATED_AT),
    approvedBy: row.APPROVED_BY ? String(row.APPROVED_BY) : null,
  };
}
export async function getKnowledge(sql: SqlSession, actor: Actor, id: string) {
  const [row] = await sql.query(
    "SELECT * FROM KNOWLEDGE_ENTRIES WHERE WORKSPACE_ID = ? AND ID = ?",
    [actor.workspaceId, id],
  );
  if (!row)
    throw new DomainError("NOT_FOUND", "Knowledge entry not found.", 404);
  return mapKnowledge(row);
}
export async function listKnowledge(actor: Actor) {
  return readDatabase(async (sql) => {
    await requireOperator(sql, actor);
    const rows = await sql.query(
      "SELECT * FROM KNOWLEDGE_ENTRIES WHERE WORKSPACE_ID = ? ORDER BY CREATED_AT DESC,ID LIMIT 101",
      [actor.workspaceId],
    );
    return {
      entries: rows.slice(0, 100).map(mapKnowledge),
      hasMore: rows.length > 100,
    };
  });
}
export async function approvedKnowledge(
  sql: SqlSession,
  actor: Actor,
  query?: string,
) {
  const terms = query === undefined ? [] : knowledgeQueryTerms(query);
  const filter = terms.length
    ? ` AND (KIND<>'reference' OR ${terms.map(() => "INSTR(LOWER(CONTENT_JSON),LOWER(?))>0").join(" OR ")})`
    : "";
  const rows = await sql.query(
    `SELECT * FROM KNOWLEDGE_ENTRIES WHERE WORKSPACE_ID = ? AND LIFECYCLE = 'approved'${filter} ORDER BY ID LIMIT 501`,
    [actor.workspaceId, ...terms],
  );
  if (rows.length > 500)
    throw new DomainError(
      "KNOWLEDGE_LIMIT",
      "More than 500 passages match. Use a specific document name or distinctive search terms.",
      422,
    );
  return rows
    .map(mapKnowledge)
    .filter((entry) =>
      activeKnowledge(entry, new Date().toISOString().slice(0, 10)),
    );
}
export async function approvedKnowledgeByIds(
  sql: SqlSession,
  actor: Actor,
  ids: string[],
) {
  if (!ids.length) return [];
  const rows = await sql.query(
    `SELECT * FROM KNOWLEDGE_ENTRIES WHERE WORKSPACE_ID=? AND LIFECYCLE='approved' AND ID IN (${ids.map(() => "?").join(",")}) ORDER BY ID`,
    [actor.workspaceId, ...ids],
  );
  return rows
    .map(mapKnowledge)
    .filter((entry) =>
      activeKnowledge(entry, new Date().toISOString().slice(0, 10)),
    );
}
// The entire approved corpus remains a dependency even when retrieval reads only
// matching passages. Including the date conservatively expires cached decisions.
export async function approvedKnowledgeDigest(sql: SqlSession, actor: Actor) {
  const rows: Row[] = [];
  let after = "";
  // Stay inside the database driver's 501-row response boundary. Exasol keeps
  // these keyset pages in the same read transaction.
  for (;;) {
    const page = await sql.query(
      `SELECT ID,VERSION,CONTENT_HASH FROM KNOWLEDGE_ENTRIES WHERE WORKSPACE_ID=? AND LIFECYCLE='approved'${after ? " AND ID>?" : ""} ORDER BY ID LIMIT 500`,
      after ? [actor.workspaceId, after] : [actor.workspaceId],
    );
    rows.push(...page);
    if (rows.length > 10000)
      throw new DomainError(
        "KNOWLEDGE_LIMIT",
        "This workspace exceeds 10,000 approved passages. Narrow the connected libraries.",
        422,
      );
    if (page.length < 500) break;
    after = String(page[page.length - 1].ID);
  }
  return digest({
    day: new Date().toISOString().slice(0, 10),
    entries: rows.map((row) => ({
      id: row.ID,
      version: Number(row.VERSION),
      hash: row.CONTENT_HASH,
    })),
  });
}
async function eligibleOwner(
  sql: SqlSession,
  actor: Actor,
  values: KnowledgeInput,
) {
  if (!values.ownerId) return;
  const member = await membership(sql, { ...actor, userId: values.ownerId! });
  if (!canOperate(member))
    throw new DomainError(
      "INVALID_OWNER",
      "Routing rules require an active owner or operator in this workspace.",
      422,
    );
}
export async function createKnowledge(
  actor: Actor,
  commandId: string,
  input: KnowledgeInput,
) {
  const values = knowledgeInputSchema.parse(input),
    hash = digest({ type: "knowledge-create", values });
  if (values.provenance || values.externalSource)
    throw new DomainError(
      "KNOWLEDGE_PROVENANCE",
      "Create decision-backed knowledge from its reviewed proposal so the server can verify its source.",
      422,
    );
  return writeDatabase(async (sql) => {
    await requireOperator(sql, actor);
    const existing = await receipt<{ id: string }>(sql, actor, commandId, hash);
    if (existing) return getKnowledge(sql, actor, existing.id);
    await eligibleOwner(sql, actor, values);
    if (values.supersedesId) {
      const previous = await getKnowledge(sql, actor, values.supersedesId);
      // A replacement remains connected to the original reviewed decision.
      // Clients cannot supply or rewrite the server-verified provenance.
      if (previous.provenance) values.provenance = previous.provenance;
    }
    const id = await insertKnowledgeDraft(sql, actor, values);
    await saveReceipt(sql, actor, commandId, hash, { id });
    return getKnowledge(sql, actor, id);
  });
}
async function insertKnowledgeDraft(
  sql: SqlSession,
  actor: Actor,
  values: KnowledgeInput,
) {
  const id = randomUUID();
  await sql.execute(
    "INSERT INTO KNOWLEDGE_ENTRIES (WORKSPACE_ID,ID,VERSION,LIFECYCLE,KIND,DATASET,CONTENT_JSON,CONTENT_HASH,CREATED_BY,CREATED_AT,APPROVED_BY) VALUES (?,?,1,'draft',?,?,?,?,?,?,NULL)",
    [
      actor.workspaceId,
      id,
      values.kind,
      values.dataset || null,
      JSON.stringify(values),
      digest(values),
      actor.userId,
      sqlTimestamp(new Date().toISOString()),
    ],
  );
  await agentEvent(sql, actor, id, "knowledge_drafted", 1);
  return id;
}
async function reviewedDecisionSource(
  sql: SqlSession,
  actor: Actor,
  proposalId: string,
  proposalHash: string,
) {
  const member = await requireOperator(sql, actor);
  const [row] = await sql.query(
    "SELECT * FROM TRIAGE_PROPOSALS WHERE WORKSPACE_ID = ? AND ID = ?",
    [actor.workspaceId, proposalId],
  );
  if (!row) throw new DomainError("NOT_FOUND", "Proposal not found.", 404);
  const content = JSON.parse(String(row.CONTENT_JSON)) as ProposalContent;
  if (row.CONTENT_HASH !== proposalHash || digest(content) !== proposalHash)
    throw new DomainError(
      "PROPOSAL_HASH",
      "Proposal content does not match this decision. Refresh its saved review.",
      409,
    );
  if (
    content.workspaceId !== actor.workspaceId ||
    content.id !== proposalId ||
    content.runId !== row.RUN_ID ||
    content.requestId !== row.REQUEST_ID ||
    !["openrouter-v1", "external-mcp-v1", "conversation-v1"].includes(
      content.engine,
    )
  )
    throw new DomainError(
      "PROPOSAL_CONTEXT",
      "The decision source does not match its saved workspace and record.",
      409,
    );
  if (row.LIFECYCLE !== "applied" || !row.REVIEWED_BY)
    throw new DomainError(
      "DECISION_NOT_REVIEWED",
      "Apply a reviewed proposal before recording reusable guidance from it.",
      409,
    );
  const current = await getRequest(sql, actor, member, content.requestId);
  if (current.version !== content.after.version)
    throw new DomainError(
      "STALE_DECISION",
      "The record changed after this decision. Review a new proposal before reusing it as guidance.",
      409,
    );
  const tool = await publishedTool(sql, actor);
  if (content.toolRevision !== `request-desk-v${tool.revision}`)
    throw new DomainError(
      "STALE_TOOL",
      "The tool changed after this decision. Review a new proposal before reusing it as guidance.",
      409,
    );
  for (const dependency of content.evidence) {
    const entry = await getKnowledge(sql, actor, dependency.id);
    if (
      entry.version !== dependency.version ||
      entry.contentHash !== dependency.contentHash ||
      !activeKnowledge(entry, new Date().toISOString().slice(0, 10))
    )
      throw new DomainError(
        "STALE_KNOWLEDGE",
        "This decision's evidence changed or is no longer approved. Review a new proposal before reusing it.",
        409,
      );
  }
  return { content, reviewedBy: String(row.REVIEWED_BY) };
}
export async function createKnowledgeFromProposal(
  actor: Actor,
  proposalId: string,
  input: ProposalKnowledgeInput,
) {
  const values = proposalKnowledgeSchema.parse(input);
  const hash = digest({
    type: "decision-knowledge-create",
    proposalId,
    ...values,
  });
  return writeDatabase(async (sql) => {
    await requireOperator(sql, actor);
    // Reconcile an acknowledged draft before rechecking its historical source.
    const existing = await receipt<{ id: string }>(
      sql,
      actor,
      values.commandId,
      hash,
    );
    if (existing) return getKnowledge(sql, actor, existing.id);
    const source = await reviewedDecisionSource(
      sql,
      actor,
      proposalId,
      values.hash,
    );
    const now = new Date().toISOString();
    const provenance: KnowledgeProvenance = {
      type: "reviewed_decision",
      proposalId,
      proposalHash: values.hash,
      runId: source.content.runId,
      requestId: source.content.requestId,
      requestVersion: source.content.after.version,
      reviewedBy: source.reviewedBy,
      recordedBy: actor.userId,
      recordedAt: now,
      rationale: values.rationale,
    };
    const draft = knowledgeInputSchema.parse({
      title: values.title,
      kind: values.kind,
      content: values.body,
      dataset: source.content.after.dataset,
      ownerId: null,
      effectiveFrom: now.slice(0, 10),
      effectiveUntil: null,
      supersedesId: null,
      provenance,
    });
    const id = await insertKnowledgeDraft(sql, actor, draft);
    await agentEvent(sql, actor, proposalId, "decision_knowledge_drafted", 1);
    await saveReceipt(sql, actor, values.commandId, hash, { id });
    return getKnowledge(sql, actor, id);
  });
}
export async function changeKnowledge(
  actor: Actor,
  id: string,
  commandId: string,
  expectedVersion: number,
  action: "approve" | "retire",
) {
  const hash = digest({ type: "knowledge-state", id, expectedVersion, action });
  return writeDatabase(async (sql) => {
    const reviewer: Membership = await requireOperator(sql, actor);
    if (reviewer.role !== "owner")
      throw new DomainError(
        "ACCESS_DENIED",
        "Only an owner can approve or retire reusable knowledge.",
        403,
      );
    const entry = await getKnowledge(sql, actor, id);
    if (await receipt(sql, actor, commandId, hash)) return entry;
    if (entry.version !== expectedVersion)
      throw new DomainError(
        "VERSION_CONFLICT",
        "Knowledge changed. Refresh before reviewing.",
        409,
      );
    if (
      (action === "approve" && entry.state !== "draft") ||
      (action === "retire" && !["draft", "approved"].includes(entry.state))
    )
      throw new DomainError(
        "KNOWLEDGE_STATE",
        "This knowledge state cannot make that transition.",
        409,
      );
    if (action === "approve") {
      await eligibleOwner(sql, actor, entry);
      if (entry.provenance) {
        const source = await reviewedDecisionSource(
          sql,
          actor,
          entry.provenance.proposalId,
          entry.provenance.proposalHash,
        );
        if (
          source.content.runId !== entry.provenance.runId ||
          source.content.requestId !== entry.provenance.requestId ||
          source.content.after.version !== entry.provenance.requestVersion ||
          source.reviewedBy !== entry.provenance.reviewedBy
        )
          throw new DomainError(
            "KNOWLEDGE_PROVENANCE",
            "The draft provenance no longer matches its reviewed decision.",
            409,
          );
      }
      if (entry.supersedesId) {
        const previous = await getKnowledge(sql, actor, entry.supersedesId);
        if (previous.state !== "approved" || previous.kind !== entry.kind)
          throw new DomainError(
            "KNOWLEDGE_CONFLICT",
            "The superseded entry must still be approved and have the same kind.",
            409,
          );
        const superseded = await sql.execute(
          "UPDATE KNOWLEDGE_ENTRIES SET LIFECYCLE = 'superseded',VERSION = VERSION + 1 WHERE WORKSPACE_ID = ? AND ID = ? AND VERSION = ?",
          [actor.workspaceId, previous.id, previous.version],
        );
        if (superseded !== 1)
          throw new DomainError(
            "KNOWLEDGE_CONFLICT",
            "The source changed before replacement approval.",
            409,
          );
        await agentEvent(
          sql,
          actor,
          previous.id,
          "knowledge_superseded",
          previous.version + 1,
        );
      }
    }
    const changed = await sql.execute(
      "UPDATE KNOWLEDGE_ENTRIES SET LIFECYCLE = ?,VERSION = VERSION + 1,APPROVED_BY = ? WHERE WORKSPACE_ID = ? AND ID = ? AND VERSION = ?",
      [
        action === "approve" ? "approved" : "retired",
        action === "approve" ? actor.userId : entry.approvedBy,
        actor.workspaceId,
        id,
        expectedVersion,
      ],
    );
    if (changed !== 1)
      throw new DomainError(
        "VERSION_CONFLICT",
        "Knowledge changed. Refresh before reviewing.",
        409,
      );
    await agentEvent(
      sql,
      actor,
      id,
      `knowledge_${action === "approve" ? "approved" : "retired"}`,
      expectedVersion + 1,
    );
    await saveReceipt(sql, actor, commandId, hash, { id });
    return getKnowledge(sql, actor, id);
  });
}
