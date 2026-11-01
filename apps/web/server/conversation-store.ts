import "server-only";
import type {
  Actor,
  AnalyticsInsights,
  ConversationCitation,
  ConversationMessage,
  KnowledgeEntry,
  Membership,
  ModelInference,
  PublishedTool,
  PublicRequest,
  ToolDraft,
  TriageProposal,
} from "@loom/contracts";
import { DomainError, retrieveKnowledge } from "@loom/domain";
import { fromTimestamp, type Row, type SqlSession } from "@loom/db-exasol";
import {
  digest,
  getRequest,
  mapRequest,
  membership,
  membersFor,
  requestFilter,
  requestSelect,
  visibleRequest,
} from "./desk";
import {
  approvedKnowledge,
  approvedKnowledgeDigest,
  getKnowledge,
} from "./knowledge";
import { publishedTool } from "./tool-definitions";
import { analyticsInsights } from "@loom/analytics";

export type ConversationInsights = Pick<
  AnalyticsInsights,
  | "days"
  | "from"
  | "asOf"
  | "phases"
  | "flow"
  | "owners"
  | "evidence"
  | "semantics"
> & {
  purpose: "explanatory_snapshot";
  ownersHasMore: boolean;
};

export type ConversationContext = {
  today: string;
  visibility: "internal" | "member";
  member: Membership;
  tool: PublishedTool;
  records: PublicRequest[];
  recordsHasMore: boolean;
  knowledge: KnowledgeEntry[];
  knowledgeDigest: string;
  members: Membership[];
  history: { role: "user" | "assistant"; content: string }[];
  prompt: string;
  allowProposals: boolean;
  allowToolDesign: boolean;
  // Optional for previously persisted turns. This is explanatory evidence,
  // never a replacement for record versions/permissions in action approval.
  insights?: ConversationInsights;
};
export type ConversationResult = {
  reply: string;
  citations: ConversationCitation[];
  proposalIds: string[];
  toolDraft?: ToolDraft;
  inference?: ModelInference;
  error?: string;
};
export type ConversationTurn = {
  id: string;
  workspaceId: string;
  userId: string;
  commandId: string;
  prompt: string;
  visibility: "internal" | "member";
  state: "queued" | "running" | "completed" | "failed";
  provider: "loom" | "codex" | "claude-code" | "other";
  version: number;
  contextHash: string;
  context: ConversationContext;
  result: ConversationResult | null;
  leaseUntil: string | null;
  connectionId: string | null;
  createdAt: string;
  updatedAt: string;
};
export function mapConversationTurn(row: Row): ConversationTurn {
  const context = JSON.parse(String(row.CONTEXT_JSON)) as ConversationContext;
  if (digest(context) !== String(row.CONTEXT_HASH))
    throw new DomainError(
      "CONVERSATION_INTEGRITY",
      "This saved conversation failed its context check.",
      409,
    );
  return {
    id: String(row.ID),
    workspaceId: String(row.WORKSPACE_ID),
    userId: String(row.USER_ID),
    commandId: String(row.COMMAND_ID),
    prompt: String(row.PROMPT),
    visibility: row.VISIBILITY as ConversationTurn["visibility"],
    state: row.STATE as ConversationTurn["state"],
    provider: row.PROVIDER as ConversationTurn["provider"],
    version: Number(row.VERSION),
    contextHash: String(row.CONTEXT_HASH),
    context,
    result: row.RESULT_JSON
      ? (JSON.parse(String(row.RESULT_JSON)) as ConversationResult)
      : null,
    leaseUntil: row.LEASE_UNTIL ? fromTimestamp(row.LEASE_UNTIL) : null,
    connectionId: row.CONNECTION_ID ? String(row.CONNECTION_ID) : null,
    createdAt: fromTimestamp(row.CREATED_AT),
    updatedAt: fromTimestamp(row.UPDATED_AT),
  };
}
export async function getConversationTurn(
  sql: SqlSession,
  actor: Actor,
  id: string,
): Promise<ConversationTurn> {
  const member = await membership(sql, actor);
  const [row] = await sql.query(
    "SELECT * FROM CONVERSATION_TURNS WHERE WORKSPACE_ID=? AND USER_ID=? AND ID=?",
    [actor.workspaceId, actor.userId, id],
  );
  if (!row)
    throw new DomainError("NOT_FOUND", "Conversation message not found.", 404);
  const turn = mapConversationTurn(row);
  if (turn.context.member.role !== member.role)
    throw new DomainError(
      "ACCESS_DENIED",
      "This conversation was saved under different workspace access.",
      403,
    );
  return turn;
}
export async function conversationContext(
  sql: SqlSession,
  actor: Actor,
  prompt: string,
  history: ConversationContext["history"] = [],
): Promise<ConversationContext> {
  const member = await membership(sql, actor);
  const internal = ["owner", "operator"].includes(member.role);
  const filter = requestFilter(member, { search: "", status: "all", page: 0 });
  const rows = await sql.query(
    `${requestSelect} WHERE R.WORKSPACE_ID=?${filter.sql} ORDER BY R.UPDATED_AT DESC,R.ID LIMIT 51`,
    [actor.workspaceId, ...filter.values],
  );
  const knowledge = internal ? await approvedKnowledge(sql, actor, prompt) : [];
  const selected = retrieveKnowledge(knowledge, prompt, {
    workspaceId: actor.workspaceId,
    limit: 12,
  });
  const context: ConversationContext = {
    today: new Date().toISOString().slice(0, 10),
    visibility: internal ? "internal" : "member",
    member,
    tool: await publishedTool(sql, actor),
    records: rows
      .slice(0, 50)
      .map(mapRequest)
      .map((record) => visibleRequest(member, record)),
    recordsHasMore: rows.length > 50,
    knowledge: selected.map((match) => match.entry),
    knowledgeDigest: internal
      ? await approvedKnowledgeDigest(sql, actor)
      : digest([]),
    members: internal ? await membersFor(sql, actor) : [],
    history: history.slice(-8),
    prompt,
    allowProposals: internal,
    allowToolDesign: member.role === "owner",
  };
  if (internal) {
    const computed = await analyticsInsights(sql, actor, 30, new Date(), false);
    context.insights = {
      purpose: "explanatory_snapshot",
      days: computed.days,
      from: computed.from,
      asOf: computed.asOf,
      phases: computed.phases,
      flow: computed.flow,
      owners: computed.owners.slice(0, 20),
      ownersHasMore: computed.hasMore.owners || computed.owners.length > 20,
      evidence: computed.evidence,
      semantics: computed.semantics,
    };
  }
  if (Buffer.byteLength(JSON.stringify(context), "utf8") > 120_000)
    throw new DomainError(
      "CONVERSATION_CONTEXT_LIMIT",
      "The saved workspace context is too large for one reply. Narrow the workspace records or shorten the conversation.",
      422,
    );
  return context;
}
export async function assertConversationContext(
  sql: SqlSession,
  actor: Actor,
  context: ConversationContext,
) {
  if (context.today !== new Date().toISOString().slice(0, 10))
    throw new DomainError(
      "STALE_CONVERSATION",
      "The day changed while this prompt was waiting. Send it again to use the current date.",
      409,
    );
  const member = await membership(sql, actor);
  if (
    member.role !== context.member.role ||
    member.userId !== context.member.userId
  )
    throw new DomainError(
      "CONVERSATION_ACCESS_CHANGED",
      "Your workspace role changed while the agent was replying. Send the prompt again with your current access.",
      409,
    );
  if ((await publishedTool(sql, actor)).revision !== context.tool.revision)
    throw new DomainError(
      "STALE_TOOL",
      "The shared tool changed while the agent was replying. Send the prompt again with the current tool.",
      409,
    );
  for (const before of context.records) {
    const current = await getRequest(sql, actor, member, before.id);
    if (current.version !== before.version)
      throw new DomainError(
        "STALE_CONVERSATION",
        "A record changed while the agent was replying. Send the prompt again to use its current information.",
        409,
      );
  }
  if (
    (context.allowProposals
      ? await approvedKnowledgeDigest(sql, actor)
      : digest([])) !== context.knowledgeDigest
  )
    throw new DomainError(
      "STALE_KNOWLEDGE",
      "Approved team context changed while the agent was replying. Send the prompt again.",
      409,
    );
  if (
    context.allowProposals &&
    digest(await membersFor(sql, actor)) !== digest(context.members)
  )
    throw new DomainError(
      "CONVERSATION_ACCESS_CHANGED",
      "Team membership changed while the agent was replying. Send the prompt again.",
      409,
    );
  const knowledge = [];
  for (const entry of context.knowledge) {
    const current = await getKnowledge(sql, actor, entry.id);
    if (
      current.version !== entry.version ||
      current.contentHash !== entry.contentHash
    )
      throw new DomainError(
        "STALE_KNOWLEDGE",
        "A cited passage changed. Send the prompt again.",
        409,
      );
    knowledge.push(current);
  }
  return { member, knowledge };
}
export async function conversationMessagesFor(
  sql: SqlSession,
  actor: Actor,
): Promise<{ messages: ConversationMessage[]; hasMore: boolean }> {
  const member = await membership(sql, actor);
  const internal = ["owner", "operator"].includes(member.role);
  const rows = await sql.query(
    `SELECT * FROM CONVERSATION_TURNS WHERE WORKSPACE_ID=? AND USER_ID=?${internal ? "" : " AND VISIBILITY='member'"} ORDER BY CREATED_AT DESC,ID DESC LIMIT 51`,
    [actor.workspaceId, actor.userId],
  );
  const messages: ConversationMessage[] = [];
  for (const row of rows.slice(0, 50).reverse()) {
    const turn = mapConversationTurn(row);
    // A reply can describe every record or owner-only tool details visible to
    // its original role. Neither its text nor its prompt is safe history for
    // another role, even when both roles share the same visibility category.
    if (turn.context.member.role !== member.role) continue;
    const expired =
      turn.state === "running" &&
      turn.leaseUntil &&
      turn.leaseUntil <= new Date().toISOString();
    const result = turn.result;
    const proposals: TriageProposal[] = [];
    if (internal)
      for (const id of result?.proposalIds || []) {
        const [proposal] = await sql.query(
          "SELECT CONTENT_JSON,CONTENT_HASH,LIFECYCLE,REVIEWED_BY FROM TRIAGE_PROPOSALS WHERE WORKSPACE_ID=? AND ID=?",
          [actor.workspaceId, id],
        );
        if (!proposal) continue;
        const content = JSON.parse(
          String(proposal.CONTENT_JSON),
        ) as TriageProposal["content"];
        if (
          content.workspaceId !== actor.workspaceId ||
          digest(content) !== proposal.CONTENT_HASH ||
          (content.engine === "external-mcp-v1"
            ? content.sourceTaskId !== turn.id ||
              content.sourceConnectionId !== turn.connectionId
            : content.initiatorId !== actor.userId)
        )
          throw new DomainError(
            "PROPOSAL_INTEGRITY",
            "A conversation proposal failed its saved content check.",
            409,
          );
        proposals.push({
          content,
          hash: String(proposal.CONTENT_HASH),
          state: proposal.LIFECYCLE as TriageProposal["state"],
          reviewedBy: proposal.REVIEWED_BY
            ? String(proposal.REVIEWED_BY)
            : null,
        });
      }
    messages.push({
      id: `${turn.id}:user`,
      role: "user",
      content: turn.prompt,
      createdAt: turn.createdAt,
      state: "complete",
    });
    messages.push({
      id: `${turn.id}:assistant`,
      role: "assistant",
      content: expired
        ? "This reply was interrupted before it could be saved. Send the prompt again to try a new reply."
        : result?.reply || "",
      createdAt: turn.updatedAt,
      state:
        turn.state === "failed" || expired
          ? "failed"
          : turn.state === "completed"
            ? "complete"
            : "pending",
      citations: result?.citations || [],
      proposals,
      ...(result?.toolDraft && member.role === "owner"
        ? { toolDraft: result.toolDraft }
        : {}),
      ...(result?.inference ? { inference: result.inference } : {}),
    });
  }
  return { messages, hasMore: rows.length > 50 };
}
