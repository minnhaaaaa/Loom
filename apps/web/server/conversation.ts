import "server-only";
import { randomUUID } from "node:crypto";
import {
  conversationSendSchema,
  type Actor,
  type ConversationConfiguration,
  type ConversationSend,
  type ConversationSnapshot,
  type ProposalContent,
  type ModelInference,
  type TriageStep,
} from "@loom/contracts";
import { DomainError } from "@loom/domain";
import {
  readDatabase,
  writeDatabase,
  sqlTimestamp,
  type SqlSession,
} from "@loom/db-exasol";
import { digest, getRequest, membership, receipt } from "./desk";
import { agentEvent, saveReceipt } from "./knowledge";
import { modelConfiguration } from "./openrouter";
import { settingsFor } from "./settings";
import { generateToolDraft } from "./tools";
import { validateSuggestion } from "./triage";
import {
  inferConversation,
  type ConversationDecision,
} from "./conversation-model";
import {
  assertConversationContext,
  conversationContext,
  conversationMessagesFor,
  getConversationTurn,
  mapConversationTurn,
  type ConversationContext,
  type ConversationResult,
} from "./conversation-store";

export async function conversationConfiguration(
  sql: SqlSession,
  actor: Actor,
): Promise<ConversationConfiguration> {
  const member = await membership(sql, actor),
    settings = await settingsFor(sql, actor);
  const choice = settings.preferredAgent;
  if (choice === "codex" || choice === "claude-code" || choice === "other") {
    const internal = ["owner", "operator"].includes(member.role);
    const active = internal
      ? await sql.query(
          "SELECT C.ID FROM AGENT_CONNECTIONS C JOIN MEMBERSHIPS M ON M.WORKSPACE_ID=C.WORKSPACE_ID AND M.USER_ID=C.CREATED_BY WHERE C.WORKSPACE_ID=? AND C.CLIENT=? AND C.REVOKED_AT IS NULL AND C.EXPIRES_AT>? AND M.ACTIVE=TRUE AND M.ROLE='owner' LIMIT 1",
          [actor.workspaceId, choice, sqlTimestamp(new Date().toISOString())],
        )
      : [];
    const configured = internal && active.length > 0;
    return {
      configured,
      mode: configured ? "external" : "unavailable",
      provider: choice,
      model: null,
      message: !internal
        ? "The company agent is currently available to internal teammates. Ask your workspace owner to provide an agent for your role."
        : configured
          ? "Your prompt is saved for your company's connected agent. Replies appear here when that client picks it up."
          : member.role === "owner"
            ? "Create an active connection for your chosen agent in Company setup before sending prompts."
            : "Ask your workspace owner to create an active connection for the chosen company agent before sending prompts.",
    };
  }
  try {
    const config = modelConfiguration();
    return {
      configured: true,
      mode: "builtin",
      provider: "loom",
      model: config.model,
      message:
        "Ask a question or describe what you want to do. The agent uses the workspace information you can access.",
    };
  } catch (error) {
    return {
      configured: false,
      mode: "unavailable",
      provider: "loom",
      model: null,
      message:
        error instanceof DomainError
          ? error.message
          : "The workspace agent is not configured.",
    };
  }
}
async function snapshotFor(
  sql: SqlSession,
  actor: Actor,
): Promise<ConversationSnapshot> {
  return {
    ...(await conversationMessagesFor(sql, actor)),
    configuration: await conversationConfiguration(sql, actor),
  };
}
export async function readConversation(actor: Actor) {
  return readDatabase((sql) => snapshotFor(sql, actor));
}

async function saveProposals(
  sql: SqlSession,
  actor: Actor,
  context: ConversationContext,
  decision: ConversationDecision,
  inference: ModelInference,
): Promise<string[]> {
  if (!decision.proposals.length) return [];
  if (!context.allowProposals)
    throw new DomainError(
      "MODEL_ACTION_DENIED",
      "The agent proposed changes outside your current role. No proposal was saved.",
      502,
    );
  if (
    new Set(decision.proposals.map((proposal) => proposal.requestId)).size !==
    decision.proposals.length
  )
    throw new DomainError(
      "MODEL_ACTION_INVALID",
      "The agent proposed the same record more than once. No proposal was saved.",
      502,
    );
  const now = new Date().toISOString(),
    expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const runId = randomUUID();
  const requestIds = decision.proposals.map((proposal) => proposal.requestId);
  await sql.execute(
    "INSERT INTO AGENT_RUNS (WORKSPACE_ID,ID,INITIATOR_ID,REQUEST_IDS_JSON,STATUS,VERSION,CHECKPOINT,CREATED_AT,EXPIRES_AT,ENGINE,TOOL_REVISION,MODEL,INSTRUCTIONS,PROMPT_VERSION) VALUES (?,?,?,?,'completed',1,?,?,?,'conversation-v1',?,?,?,'conversation-v1')",
    [
      actor.workspaceId,
      runId,
      actor.userId,
      JSON.stringify(requestIds),
      requestIds.length,
      sqlTimestamp(now),
      sqlTimestamp(expiresAt),
      `request-desk-v${context.tool.revision}`,
      inference.requestedModel,
      context.prompt,
    ],
  );
  const ids: string[] = [];
  for (const [index, proposal] of decision.proposals.entries()) {
    const sampled = context.records.find(
      (record) => record.id === proposal.requestId,
    );
    if (!sampled || sampled.version !== proposal.expectedVersion)
      throw new DomainError(
        "MODEL_RECORD_INVALID",
        "The agent referred to a record outside its current context. No proposal was saved.",
        502,
      );
    const before = await getRequest(
      sql,
      actor,
      context.member,
      proposal.requestId,
    );
    if (before.version !== proposal.expectedVersion)
      throw new DomainError(
        "STALE_PROPOSAL",
        "A record changed before the reply was saved. Send your prompt again.",
        409,
      );
    const validated = validateSuggestion(
      {
        inference,
        suggestion: {
          summary: decision.reply.slice(0, 2000),
          reasons: proposal.reasons,
          uncertainty: proposal.uncertainty,
          evidenceIds: proposal.evidenceIds,
          commands: proposal.commands,
        },
      },
      before,
      context.member,
      context.members,
      context.knowledge,
      context.tool.spec,
    );
    const id = randomUUID();
    const content: ProposalContent = {
      workspaceId: actor.workspaceId,
      runId,
      id,
      revision: 1,
      initiatorId: actor.userId,
      engine: "conversation-v1",
      inference,
      toolRevision: `request-desk-v${context.tool.revision}`,
      requestId: before.id,
      expectedVersion: before.version,
      before,
      commands: validated.suggestion.commands,
      after: validated.after,
      evidence: validated.evidence.map((entry) => ({
        id: entry.id,
        version: entry.version,
        contentHash: entry.contentHash,
        title: entry.title,
      })),
      knowledgeDigest: context.knowledgeDigest,
      reasons: proposal.reasons,
      uncertainty: proposal.uncertainty,
      expiresAt,
    };
    if (Buffer.byteLength(JSON.stringify(content), "utf8") > 140_000)
      throw new DomainError(
        "CONVERSATION_PROPOSAL_LIMIT",
        "The agent's proposed changes are too large to review together. Ask for a smaller change.",
        422,
      );
    const hash = digest(content);
    await sql.execute(
      "INSERT INTO TRIAGE_PROPOSALS (WORKSPACE_ID,ID,RUN_ID,REQUEST_ID,CONTENT_JSON,CONTENT_HASH,LIFECYCLE,REVIEWED_BY) VALUES (?,?,?,?,?,?,'pending',NULL)",
      [actor.workspaceId, id, runId, before.id, JSON.stringify(content), hash],
    );
    const step: TriageStep = {
      index,
      requestId: before.id,
      requestVersion: before.version,
      summary: decision.reply.slice(0, 2000),
      uncertainty: proposal.uncertainty,
      proposalId: id,
      inference,
    };
    if (Buffer.byteLength(JSON.stringify(step), "utf8") > 9500)
      throw new DomainError(
        "CONVERSATION_PROPOSAL_LIMIT",
        "The agent's explanation is too large to save. Ask for a shorter reply.",
        422,
      );
    await sql.execute(
      "INSERT INTO AGENT_STEPS (WORKSPACE_ID,RUN_ID,STEP_INDEX,REQUEST_ID,REQUEST_VERSION,OUTPUT_JSON,PROPOSAL_ID) VALUES (?,?,?,?,?,?,?)",
      [
        actor.workspaceId,
        runId,
        index,
        before.id,
        before.version,
        JSON.stringify(step),
        id,
      ],
    );
    await agentEvent(sql, actor, id, "conversation_proposal_created", 1);
    ids.push(id);
  }
  return ids;
}

export async function sendConversation(
  actor: Actor,
  input: ConversationSend,
  signal?: AbortSignal,
): Promise<ConversationSnapshot> {
  const values = conversationSendSchema.parse(input),
    payloadHash = digest({ type: "conversation-send", ...values });
  const reservation = await writeDatabase(async (sql) => {
    const member = await membership(sql, actor);
    const saved = await receipt<{ id: string }>(
      sql,
      actor,
      values.commandId,
      payloadHash,
    );
    if (saved) {
      await getConversationTurn(sql, actor, saved.id);
      return { existing: true as const };
    }
    const configuration = await conversationConfiguration(sql, actor);
    if (!configuration.configured)
      throw new DomainError(
        "CONVERSATION_UNAVAILABLE",
        configuration.message,
        503,
      );
    const pending = await sql.query(
      "SELECT * FROM CONVERSATION_TURNS WHERE WORKSPACE_ID=? AND USER_ID=? AND \"STATE\" IN ('queued','running') AND (LEASE_UNTIL IS NULL OR LEASE_UNTIL>?)",
      [actor.workspaceId, actor.userId, sqlTimestamp(new Date().toISOString())],
    );
    if (
      pending.filter(
        (row) => mapConversationTurn(row).context.member.role === member.role,
      ).length >= 10
    )
      throw new DomainError(
        "CONVERSATION_PENDING_LIMIT",
        "You already have ten prompts waiting for a reply. Let the agent answer before sending more.",
        429,
      );
    const history = (await conversationMessagesFor(sql, actor)).messages
      .filter((message) => message.state === "complete")
      .map(({ role, content }) => ({ role, content }));
    const context = await conversationContext(
      sql,
      actor,
      values.prompt,
      history,
    );
    const id = randomUUID(),
      now = new Date().toISOString();
    const external = configuration.mode === "external";
    const leaseUntil = external
      ? null
      : new Date(Date.now() + 5 * 60_000).toISOString();
    await sql.execute(
      'INSERT INTO CONVERSATION_TURNS (WORKSPACE_ID,ID,USER_ID,COMMAND_ID,PROMPT,VISIBILITY,"STATE",PROVIDER,VERSION,CONTEXT_HASH,CONTEXT_JSON,RESULT_JSON,LEASE_UNTIL,CONNECTION_ID,CREATED_AT,UPDATED_AT) VALUES (?,?,?,?,?,?,?,?,1,?,?,NULL,?,NULL,?,?)',
      [
        actor.workspaceId,
        id,
        actor.userId,
        values.commandId,
        values.prompt,
        context.visibility,
        external ? "queued" : "running",
        configuration.provider,
        digest(context),
        JSON.stringify(context),
        leaseUntil ? sqlTimestamp(leaseUntil) : null,
        sqlTimestamp(now),
        sqlTimestamp(now),
      ],
    );
    await saveReceipt(sql, actor, values.commandId, payloadHash, { id });
    await agentEvent(
      sql,
      actor,
      id,
      external ? "conversation_queued" : "conversation_started",
      1,
    );
    return {
      existing: false as const,
      id,
      external,
      model: configuration.model,
      context,
      member,
    };
  });
  if (reservation.existing || reservation.external)
    return readConversation(actor);
  try {
    const result = await inferConversation(
      reservation.context,
      reservation.model!,
      signal,
    );
    const available = new Set(
      reservation.context.knowledge.map((entry) => entry.id),
    );
    if (
      new Set(result.decision.evidenceIds).size !==
        result.decision.evidenceIds.length ||
      result.decision.evidenceIds.some((id) => !available.has(id))
    )
      throw new DomainError(
        "MODEL_EVIDENCE_INVALID",
        "The agent cited a source outside the approved context. No reply or changes were saved.",
        502,
      );
    if (
      result.decision.toolInstructions &&
      !reservation.context.allowToolDesign
    )
      throw new DomainError(
        "MODEL_ACTION_DENIED",
        "Only a workspace owner can generate a shared tool draft. No draft was created.",
        502,
      );
    // The designer has its own durable reservation; this separate UUID never
    // collides with the initiating message's command receipt.
    const toolDraft = result.decision.toolInstructions
      ? await generateToolDraft(
          actor,
          reservation.id,
          reservation.context.tool.revision,
          result.decision.toolInstructions,
          reservation.context.tool.spec,
        )
      : undefined;
    await writeDatabase(async (sql) => {
      await assertConversationContext(sql, actor, reservation.context);
      const turn = await getConversationTurn(sql, actor, reservation.id);
      if (
        turn.state !== "running" ||
        !turn.leaseUntil ||
        turn.leaseUntil <= new Date().toISOString()
      )
        throw new DomainError(
          "CONVERSATION_EXPIRED",
          "This reply took too long and was discarded. Send your prompt again.",
          409,
        );
      const proposalIds = await saveProposals(
        sql,
        actor,
        reservation.context,
        result.decision,
        result.inference,
      );
      const saved: ConversationResult = {
        reply: result.decision.reply,
        citations: reservation.context.knowledge
          .filter((entry) => result.decision.evidenceIds.includes(entry.id))
          .map(({ id, title, version }) => ({ id, title, version })),
        proposalIds,
        inference: result.inference,
        ...(toolDraft ? { toolDraft } : {}),
      };
      if (Buffer.byteLength(JSON.stringify(saved), "utf8") > 170_000)
        throw new DomainError(
          "CONVERSATION_REPLY_LIMIT",
          "The agent reply is too large to save. Ask for a smaller task.",
          422,
        );
      const changed = await sql.execute(
        "UPDATE CONVERSATION_TURNS SET \"STATE\"='completed',VERSION=VERSION+1,RESULT_JSON=?,UPDATED_AT=? WHERE WORKSPACE_ID=? AND USER_ID=? AND ID=? AND \"STATE\"='running' AND VERSION=1",
        [
          JSON.stringify(saved),
          sqlTimestamp(new Date().toISOString()),
          actor.workspaceId,
          actor.userId,
          turn.id,
        ],
      );
      if (changed !== 1)
        throw new DomainError(
          "CONVERSATION_CONFLICT",
          "This reply changed before it could be saved. Refresh the conversation.",
          409,
        );
      await agentEvent(sql, actor, turn.id, "conversation_answered", 2);
    });
  } catch (error) {
    const safe =
      error instanceof DomainError
        ? error.message
        : "The agent could not finish this reply. Your prompt is saved; send it again to try a new reply.";
    await writeDatabase(async (sql) => {
      await membership(sql, actor);
      await sql.execute(
        "UPDATE CONVERSATION_TURNS SET \"STATE\"='failed',VERSION=VERSION+1,RESULT_JSON=?,UPDATED_AT=? WHERE WORKSPACE_ID=? AND USER_ID=? AND ID=? AND \"STATE\"='running'",
        [
          JSON.stringify({
            reply: safe,
            citations: [],
            proposalIds: [],
            error:
              error instanceof DomainError ? error.code : "CONVERSATION_FAILED",
          }),
          sqlTimestamp(new Date().toISOString()),
          actor.workspaceId,
          actor.userId,
          reservation.id,
        ],
      );
    }).catch(() => undefined);
  }
  return readConversation(actor);
}
