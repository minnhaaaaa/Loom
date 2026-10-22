import "server-only";
import { randomUUID } from "node:crypto";
import {
  knowledgeInputSchema,
  type Actor,
  type KnowledgeEntry,
  type KnowledgeInput,
  type Membership,
} from "@loom/contracts";
import { canOperate, DomainError, routingKey } from "@loom/domain";
import {
  fromTimestamp,
  readDatabase,
  sqlTimestamp,
  writeDatabase,
  type Row,
  type SqlSession,
} from "@loom/db-exasol";
import { digest, membership, receipt } from "./desk";
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
export async function routingCandidates(
  sql: SqlSession,
  actor: Actor,
  dataset: string,
) {
  if (!dataset.trim()) return [];
  const rows = await sql.query(
    "SELECT * FROM KNOWLEDGE_ENTRIES WHERE WORKSPACE_ID = ? AND KIND = 'routing' AND LOWER(TRIM(DATASET)) = ? AND LIFECYCLE IN ('draft','approved') ORDER BY ID LIMIT 101",
    [actor.workspaceId, routingKey(dataset)],
  );
  if (rows.length > 100)
    throw new DomainError(
      "KNOWLEDGE_LIMIT",
      "More than 100 routing candidates match this dataset. Consolidate approved rules before triage.",
      422,
    );
  return rows.map(mapKnowledge);
}
export function routingDigest(entries: KnowledgeEntry[]) {
  return digest(
    entries.map((entry) => ({
      id: entry.id,
      version: entry.version,
      state: entry.state,
      hash: entry.contentHash,
    })),
  );
}
async function eligibleOwner(
  sql: SqlSession,
  actor: Actor,
  values: KnowledgeInput,
) {
  if (values.kind !== "routing") return;
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
  return writeDatabase(async (sql) => {
    await requireOperator(sql, actor);
    const existing = await receipt<{ id: string }>(sql, actor, commandId, hash);
    if (existing) return getKnowledge(sql, actor, existing.id);
    await eligibleOwner(sql, actor, values);
    if (values.supersedesId)
      await getKnowledge(sql, actor, values.supersedesId);
    const id = randomUUID(),
      now = new Date().toISOString();
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
        sqlTimestamp(now),
      ],
    );
    await agentEvent(sql, actor, id, "knowledge_drafted", 1);
    await saveReceipt(sql, actor, commandId, hash, { id });
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
