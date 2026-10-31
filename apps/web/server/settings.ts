import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import {
  createAgentConnectionSchema,
  defaultWorkspaceSettings,
  updateWorkspaceSettingsSchema,
  workspaceSettingsSchema,
  type Actor,
  type AgentConnection,
  type CreateAgentConnection,
  type CreatedAgentConnection,
  type UpdateWorkspaceSettings,
  type WorkspaceSettings,
} from "@loom/contracts";
import { DomainError } from "@loom/domain";
import {
  fromTimestamp,
  readDatabase,
  writeDatabase,
  sqlTimestamp,
  type Row,
  type SqlSession,
} from "@loom/db-exasol";
import { digest, membership, receipt } from "./desk";
import { hashToken } from "./identity-crypto";

async function requireOwner(sql: SqlSession, actor: Actor) {
  const member = await membership(sql, actor);
  if (member.role !== "owner")
    throw new DomainError(
      "ACCESS_DENIED",
      "Only a workspace owner can manage company setup and agent connections.",
      403,
    );
  return member;
}
async function recordEvent(
  sql: SqlSession,
  actor: Actor,
  kind: string,
  subject: string,
  version: number,
) {
  await sql.execute(
    "INSERT INTO WORKSPACE_EVENTS (WORKSPACE_ID,ID,ACTOR_ID,ACTION_KIND,SUBJECT_ID,VERSION,CREATED_AT) VALUES (?,?,?,?,?,?,?)",
    [
      actor.workspaceId,
      randomUUID(),
      actor.userId,
      kind,
      subject,
      version,
      sqlTimestamp(new Date().toISOString()),
    ],
  );
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

// The caller supplies an already-authorized database transaction, such as a desk snapshot.
export async function settingsFor(
  sql: SqlSession,
  actor: Actor,
): Promise<WorkspaceSettings> {
  const [row] = await sql.query(
    "SELECT VERSION,SETTINGS_JSON FROM WORKSPACE_SETTINGS WHERE WORKSPACE_ID=?",
    [actor.workspaceId],
  );
  if (!row) return structuredClone(defaultWorkspaceSettings);
  const settings = workspaceSettingsSchema.parse(
    JSON.parse(String(row.SETTINGS_JSON)),
  );
  if (settings.version !== Number(row.VERSION))
    throw new DomainError(
      "SETTINGS_INTEGRITY",
      "Workspace settings failed their version check.",
      409,
    );
  return settings;
}
export async function readWorkspaceSettings(actor: Actor) {
  return readDatabase(async (sql) => {
    await membership(sql, actor);
    return settingsFor(sql, actor);
  });
}
function assertLogo(value: string | null) {
  if (!value) return;
  const [header, body] = value.split(","),
    bytes = Buffer.from(body, "base64");
  const valid =
    header === "data:image/png;base64"
      ? bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : header === "data:image/jpeg;base64"
        ? bytes.length >= 4 &&
          bytes[0] === 255 &&
          bytes[1] === 216 &&
          bytes[2] === 255
        : header === "data:image/webp;base64" &&
          bytes.toString("ascii", 0, 4) === "RIFF" &&
          bytes.toString("ascii", 8, 12) === "WEBP";
  if (!valid || bytes.length > 135_000)
    throw new DomainError(
      "INVALID_BRAND_LOGO",
      "Choose a small PNG, JPEG, or WebP logo. Its contents must match its image type.",
      422,
    );
}
export async function updateWorkspaceSettings(
  actor: Actor,
  input: UpdateWorkspaceSettings,
): Promise<WorkspaceSettings> {
  const values = updateWorkspaceSettingsSchema.parse(input);
  assertLogo(values.branding.logoDataUrl);
  const hash = digest({ type: "workspace-settings", ...values });
  return writeDatabase(async (sql) => {
    await requireOwner(sql, actor);
    const saved = await receipt<{ version: number }>(
      sql,
      actor,
      values.commandId,
      hash,
    );
    if (saved) {
      // Settings are mutable public presentation state. Replays return current state
      // instead of retaining large logo blobs in command receipts.
      return settingsFor(sql, actor);
    }
    const current = await settingsFor(sql, actor);
    if (current.version !== values.expectedVersion)
      throw new DomainError(
        "SETTINGS_VERSION_CONFLICT",
        "Company settings changed. Refresh before saving your setup again.",
        409,
      );
    const now = new Date().toISOString();
    const next: WorkspaceSettings = {
      version: current.version + 1,
      branding: values.branding,
      preferredAgent: values.preferredAgent,
      setupCompletedAt:
        current.setupCompletedAt || (values.completeSetup ? now : null),
      updatedAt: now,
    };
    if (current.version === 0) {
      await sql.execute(
        "INSERT INTO WORKSPACE_SETTINGS (WORKSPACE_ID,VERSION,SETTINGS_JSON,UPDATED_BY,UPDATED_AT) VALUES (?,?,?,?,?)",
        [
          actor.workspaceId,
          next.version,
          JSON.stringify(next),
          actor.userId,
          sqlTimestamp(now),
        ],
      );
    } else {
      const changed = await sql.execute(
        "UPDATE WORKSPACE_SETTINGS SET VERSION=?,SETTINGS_JSON=?,UPDATED_BY=?,UPDATED_AT=? WHERE WORKSPACE_ID=? AND VERSION=?",
        [
          next.version,
          JSON.stringify(next),
          actor.userId,
          sqlTimestamp(now),
          actor.workspaceId,
          values.expectedVersion,
        ],
      );
      if (changed !== 1)
        throw new DomainError(
          "SETTINGS_VERSION_CONFLICT",
          "Company settings changed during save. Refresh before trying again.",
          409,
        );
    }
    await recordEvent(
      sql,
      actor,
      values.completeSetup && !current.setupCompletedAt
        ? "company_setup_completed"
        : "company_brand_updated",
      actor.workspaceId,
      next.version,
    );
    await saveReceipt(sql, actor, values.commandId, hash, {
      version: next.version,
    });
    return next;
  });
}
function mapConnection(row: Row): AgentConnection {
  return {
    id: String(row.ID),
    version: Number(row.VERSION),
    label: String(row.LABEL),
    client: row.CLIENT as AgentConnection["client"],
    createdBy: String(row.CREATED_BY),
    createdAt: fromTimestamp(row.CREATED_AT),
    expiresAt: fromTimestamp(row.EXPIRES_AT),
    revokedAt: row.REVOKED_AT ? fromTimestamp(row.REVOKED_AT) : null,
    lastUsedAt: row.LAST_USED_AT ? fromTimestamp(row.LAST_USED_AT) : null,
    clientName: row.CLIENT_NAME ? String(row.CLIENT_NAME) : null,
    tokenPrefix: String(row.TOKEN_PREFIX),
  };
}
async function connectionFor(sql: SqlSession, actor: Actor, id: string) {
  const [row] = await sql.query(
    "SELECT * FROM AGENT_CONNECTIONS WHERE WORKSPACE_ID=? AND ID=?",
    [actor.workspaceId, id],
  );
  if (!row)
    throw new DomainError("NOT_FOUND", "Agent connection not found.", 404);
  return mapConnection(row);
}
export async function listAgentConnections(actor: Actor) {
  return readDatabase(async (sql) => {
    await requireOwner(sql, actor);
    const rows = await sql.query(
      "SELECT * FROM AGENT_CONNECTIONS WHERE WORKSPACE_ID=? ORDER BY CREATED_AT DESC,ID LIMIT 101",
      [actor.workspaceId],
    );
    return {
      connections: rows.slice(0, 100).map(mapConnection),
      hasMore: rows.length > 100,
    };
  });
}
export async function createAgentConnection(
  actor: Actor,
  input: CreateAgentConnection,
): Promise<CreatedAgentConnection> {
  const values = createAgentConnectionSchema.parse(input),
    hash = digest({ type: "agent-connection-create", ...values });
  return writeDatabase(async (sql) => {
    await requireOwner(sql, actor);
    const saved = await receipt<{ id: string }>(
      sql,
      actor,
      values.commandId,
      hash,
    );
    if (saved)
      return {
        connection: await connectionFor(sql, actor, saved.id),
        token: null,
      };
    const now = new Date().toISOString();
    const [count] = await sql.query(
      "SELECT COUNT(*) AS TOTAL FROM AGENT_CONNECTIONS WHERE WORKSPACE_ID=? AND REVOKED_AT IS NULL AND EXPIRES_AT>?",
      [actor.workspaceId, sqlTimestamp(now)],
    );
    if (Number(count.TOTAL) >= 10)
      throw new DomainError(
        "AGENT_CONNECTION_LIMIT",
        "This workspace already has ten active agent connections. Revoke an unused connection first.",
        409,
      );
    const id = randomUUID(),
      token = `loom_agent_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(
      Date.now() + 30 * 24 * 60 * 60_000,
    ).toISOString();
    await sql.execute(
      "INSERT INTO AGENT_CONNECTIONS (ID,WORKSPACE_ID,VERSION,LABEL,CLIENT,CREATED_BY,TOKEN_HASH,TOKEN_PREFIX,CREATED_AT,EXPIRES_AT) VALUES (?,?,1,?,?,?,?,?,?,?)",
      [
        id,
        actor.workspaceId,
        values.label,
        values.client,
        actor.userId,
        hashToken(token),
        token.slice(0, 20),
        sqlTimestamp(now),
        sqlTimestamp(expiresAt),
      ],
    );
    await recordEvent(sql, actor, "agent_connection_created", id, 1);
    // Never write the raw token to a receipt, event, source, or workspace snapshot.
    await saveReceipt(sql, actor, values.commandId, hash, { id });
    return { connection: await connectionFor(sql, actor, id), token };
  });
}
export async function revokeAgentConnection(
  actor: Actor,
  id: string,
  commandId: string,
  expectedVersion: number,
) {
  const hash = digest({ type: "agent-connection-revoke", id, expectedVersion });
  return writeDatabase(async (sql) => {
    await requireOwner(sql, actor);
    const saved = await receipt<{ id: string }>(sql, actor, commandId, hash);
    if (saved) return connectionFor(sql, actor, saved.id);
    const current = await connectionFor(sql, actor, id);
    if (current.version !== expectedVersion)
      throw new DomainError(
        "AGENT_CONNECTION_CONFLICT",
        "The agent connection changed. Refresh before revoking it.",
        409,
      );
    if (!current.revokedAt) {
      const changed = await sql.execute(
        "UPDATE AGENT_CONNECTIONS SET REVOKED_AT=?,VERSION=VERSION+1 WHERE WORKSPACE_ID=? AND ID=? AND VERSION=?",
        [
          sqlTimestamp(new Date().toISOString()),
          actor.workspaceId,
          id,
          expectedVersion,
        ],
      );
      if (changed !== 1)
        throw new DomainError(
          "AGENT_CONNECTION_CONFLICT",
          "The agent connection changed during revocation.",
          409,
        );
      await recordEvent(
        sql,
        actor,
        "agent_connection_revoked",
        id,
        expectedVersion + 1,
      );
    }
    await saveReceipt(sql, actor, commandId, hash, { id });
    return connectionFor(sql, actor, id);
  });
}
export async function assertAgentConnection(
  sql: SqlSession,
  actor: Actor,
  connectionId: string,
): Promise<AgentConnection> {
  await requireOwner(sql, actor);
  const connection = await connectionFor(sql, actor, connectionId);
  if (
    connection.createdBy !== actor.userId ||
    connection.revokedAt ||
    connection.expiresAt <= new Date().toISOString()
  )
    throw new DomainError(
      "AGENT_UNAUTHORIZED",
      "This agent connection is expired, revoked, or no longer authorized.",
      401,
    );
  return connection;
}
export async function authenticateAgentToken(
  token: string,
  sql?: SqlSession,
): Promise<{ actor: Actor; connection: AgentConnection }> {
  if (!/^loom_agent_[A-Za-z0-9_-]{43}$/.test(token))
    throw new DomainError(
      "AGENT_UNAUTHORIZED",
      "A valid Loom agent bearer token is required.",
      401,
    );
  const check = async (session: SqlSession) => {
    const matches = await session.query(
      "SELECT ID,WORKSPACE_ID,CREATED_BY FROM AGENT_CONNECTIONS WHERE TOKEN_HASH=?",
      [hashToken(token)],
    );
    if (matches.length !== 1)
      throw new DomainError(
        "AGENT_UNAUTHORIZED",
        "This agent connection is unavailable.",
        401,
      );
    const row = matches[0];
    const actor = {
      workspaceId: String(row.WORKSPACE_ID),
      userId: String(row.CREATED_BY),
    };
    return {
      actor,
      connection: await assertAgentConnection(session, actor, String(row.ID)),
    };
  };
  return sql ? check(sql) : readDatabase(check);
}
export async function touchAgentConnection(
  id: string,
  clientName?: string,
): Promise<void> {
  await writeDatabase(async (sql) => {
    const [row] = await sql.query(
      "SELECT ID,WORKSPACE_ID,CREATED_BY FROM AGENT_CONNECTIONS WHERE ID=?",
      [id],
    );
    if (!row)
      throw new DomainError(
        "AGENT_UNAUTHORIZED",
        "This agent connection is unavailable.",
        401,
      );
    const actor = {
      workspaceId: String(row.WORKSPACE_ID),
      userId: String(row.CREATED_BY),
    };
    await assertAgentConnection(sql, actor, id);
    const name =
      clientName
        ?.replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
        .slice(0, 100) || null;
    await sql.execute(
      "UPDATE AGENT_CONNECTIONS SET LAST_USED_AT=?,CLIENT_NAME=COALESCE(?,CLIENT_NAME) WHERE WORKSPACE_ID=? AND ID=?",
      [sqlTimestamp(new Date().toISOString()), name, actor.workspaceId, id],
    );
  });
}
