import "server-only";
import {
  knowledgeInputSchema,
  memoryQuerySchema,
  type Actor,
  type KnowledgeEntry,
  type MemoryQuery,
  type MemoryTimelineEvent,
  type TeamMemorySnapshot,
  type TriageProposal,
} from "@loom/contracts";
import {
  buildMemoryGraph,
  DomainError,
  knowledgeQueryTerms,
  retrieveKnowledge,
} from "@loom/domain";
import { fromTimestamp, readDatabase, type Row } from "@loom/db-exasol";
import { digest, mapRequest, membersFor, requestSelect } from "./desk";
import { requireOperator } from "./knowledge";

const limits = { knowledge: 200, requests: 50, proposals: 50, events: 100 };
function mapSource(row: Row): KnowledgeEntry {
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
function mapEvent(row: Row): MemoryTimelineEvent {
  return {
    id: String(row.ID),
    resourceId: String(row.RESOURCE_ID),
    actorName: String(row.ACTOR_NAME),
    action: String(row.ACTION_KIND),
    version: Number(row.VERSION),
    createdAt: fromTimestamp(row.CREATED_AT),
  };
}

export async function readTeamMemory(
  actor: Actor,
  input: Partial<MemoryQuery> = {},
): Promise<TeamMemorySnapshot> {
  const query = memoryQuerySchema.parse(input);
  return readDatabase(async (sql) => {
    // Authorize before any source, graph, record or event is loaded.
    await requireOperator(sql, actor);
    const filter = { sql: "", values: [] as string[] };
    if (query.kind !== "all") {
      filter.sql += " AND KIND = ?";
      filter.values.push(query.kind);
    }
    if (query.dataset) {
      filter.sql += " AND LOWER(DATASET) = LOWER(?)";
      filter.values.push(query.dataset);
    }
    if (query.q) {
      const searchTerms = [
        query.q.normalize("NFKC"),
        ...knowledgeQueryTerms(query.q),
      ];
      filter.sql += ` AND (ID = LOWER(?) OR ${searchTerms.map(() => "INSTR(LOWER(CONTENT_JSON), LOWER(?)) > 0").join(" OR ")})`;
      filter.values.push(query.q, ...searchTerms);
    }
    // Bound work explicitly. A larger corpus remains visible through hasMore;
    // this endpoint does not imply an exhaustive vector or historical index.
    const sourceRows = await sql.query(
      `SELECT * FROM KNOWLEDGE_ENTRIES WHERE WORKSPACE_ID = ? AND LIFECYCLE = 'approved'${filter.sql} ORDER BY CREATED_AT DESC,ID LIMIT 201`,
      [actor.workspaceId, ...filter.values],
    );
    const knowledge = sourceRows.slice(0, limits.knowledge).map(mapSource);
    const asOf = query.asOf || new Date().toISOString().slice(0, 10);
    const options = {
      workspaceId: actor.workspaceId,
      asOf,
      ownerId: query.ownerId,
      kind: query.kind === "all" ? undefined : query.kind,
      dataset: query.dataset,
      limit: 20,
    };
    const entries = retrieveKnowledge(knowledge, query.q, options);
    const matchCount = knowledge.filter(
      (entry) => retrieveKnowledge([entry], query.q, options).length > 0,
    ).length;
    const requestRows = await sql.query(
      `${requestSelect} WHERE R.WORKSPACE_ID = ? ORDER BY R.UPDATED_AT DESC,R.ID LIMIT 51`,
      [actor.workspaceId],
    );
    const requests = requestRows.slice(0, limits.requests).map(mapRequest);
    const proposalRows = await sql.query(
      "SELECT P.CONTENT_JSON,P.CONTENT_HASH,P.LIFECYCLE,P.REVIEWED_BY FROM TRIAGE_PROPOSALS P JOIN AGENT_RUNS R ON R.WORKSPACE_ID = P.WORKSPACE_ID AND R.ID = P.RUN_ID WHERE P.WORKSPACE_ID = ? ORDER BY R.CREATED_AT DESC,P.ID LIMIT 51",
      [actor.workspaceId],
    );
    const proposals = proposalRows
      .slice(0, limits.proposals)
      .map((row): TriageProposal => {
        const content: TriageProposal["content"] = JSON.parse(
          String(row.CONTENT_JSON),
        );
        if (digest(content) !== row.CONTENT_HASH)
          throw new DomainError(
            "PROPOSAL_INTEGRITY",
            "Proposal content failed its integrity check.",
            409,
          );
        return {
          content,
          hash: String(row.CONTENT_HASH),
          state: row.LIFECYCLE as TriageProposal["state"],
          reviewedBy: row.REVIEWED_BY ? String(row.REVIEWED_BY) : null,
        };
      });
    const members = await membersFor(sql, actor);
    const agentEvents = await sql.query(
      "SELECT E.ID,E.RESOURCE_ID,E.ACTION_KIND,E.VERSION,E.CREATED_AT,M.NAME AS ACTOR_NAME FROM AGENT_EVENTS E JOIN MEMBERSHIPS M ON M.WORKSPACE_ID = E.WORKSPACE_ID AND M.USER_ID = E.ACTOR_ID WHERE E.WORKSPACE_ID = ? ORDER BY E.CREATED_AT DESC,E.ID LIMIT 101",
      [actor.workspaceId],
    );
    const requestEvents = await sql.query(
      "SELECT E.ID,E.REQUEST_ID AS RESOURCE_ID,E.ACTION_KIND,E.VERSION,E.CREATED_AT,M.NAME AS ACTOR_NAME FROM REQUEST_EVENTS E JOIN MEMBERSHIPS M ON M.WORKSPACE_ID = E.WORKSPACE_ID AND M.USER_ID = E.ACTOR_ID WHERE E.WORKSPACE_ID = ? ORDER BY E.CREATED_AT DESC,E.ID LIMIT 101",
      [actor.workspaceId],
    );
    const toolEvents = await sql.query(
      "SELECT E.ID,COALESCE(E.DRAFT_ID,E.WORKSPACE_ID) AS RESOURCE_ID,E.ACTION_KIND,E.REVISION AS VERSION,E.CREATED_AT,M.NAME AS ACTOR_NAME FROM TOOL_EVENTS E JOIN MEMBERSHIPS M ON M.WORKSPACE_ID = E.WORKSPACE_ID AND M.USER_ID = E.ACTOR_ID WHERE E.WORKSPACE_ID = ? ORDER BY E.CREATED_AT DESC,E.ID LIMIT 101",
      [actor.workspaceId],
    );
    const workspaceEvents = await sql.query(
      "SELECT E.ID,COALESCE(E.SUBJECT_ID,E.WORKSPACE_ID) AS RESOURCE_ID,E.ACTION_KIND,E.VERSION,E.CREATED_AT,COALESCE(M.NAME,'Workspace member') AS ACTOR_NAME FROM WORKSPACE_EVENTS E LEFT JOIN MEMBERSHIPS M ON M.WORKSPACE_ID = E.WORKSPACE_ID AND M.USER_ID = E.ACTOR_ID WHERE E.WORKSPACE_ID = ? ORDER BY E.CREATED_AT DESC,E.ID LIMIT 101",
      [actor.workspaceId],
    );
    const events = [
      ...agentEvents,
      ...requestEvents,
      ...toolEvents,
      ...workspaceEvents,
    ]
      .map(mapEvent)
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          left.id.localeCompare(right.id),
      );
    return {
      queriedAt: new Date().toISOString(),
      asOf,
      query,
      entries,
      graph: buildMemoryGraph({
        workspaceId: actor.workspaceId,
        requests,
        members,
        knowledge: entries.map((hit) => hit.entry),
        proposals,
      }),
      timeline: events.slice(0, limits.events),
      limits,
      hasMore: {
        knowledge:
          sourceRows.length > limits.knowledge || matchCount > entries.length,
        requests: requestRows.length > limits.requests,
        proposals: proposalRows.length > limits.proposals,
        events: events.length > limits.events,
      },
    };
  });
}
