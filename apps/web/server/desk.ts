import "server-only";
import { createHash, randomUUID } from "node:crypto";
import {
  deskQuerySchema,
  personas,
  workspaceId,
  type Actor,
  type Command,
  type DeskSnapshot,
  type DeskQuery,
  type Intake,
  type Membership,
  type RequestDetails,
  type RequestRecord,
  dataRequestTemplate,
} from "@loom/contracts";
import { sampleRequests } from "@loom/contracts/fixtures";
import {
  applyCommand,
  assertReadable,
  canOperate,
  DomainError,
  requireMembership,
  assertToolAction,
  assertToolCommand,
  assertToolValues,
  toolRequirements,
} from "@loom/domain";
import {
  DatabaseUnavailable,
  fromTimestamp,
  isConfigured,
  readDatabase,
  sqlTimestamp,
  writeDatabase,
  type Row,
  type SqlSession,
} from "@loom/db-exasol";
import { queueSummary } from "@loom/analytics";
import { publishedTool } from "./tool-definitions";
import { settingsFor } from "./settings";
import { localDemoEnabled } from "./demo-mode";

function mapMembership(row: Row): Membership {
  return {
    userId: String(row.USER_ID),
    name: String(row.NAME),
    role: row.ROLE as Membership["role"],
  };
}
export async function membership(
  sql: SqlSession,
  actor: Actor,
): Promise<Membership> {
  const [row] = await sql.query(
    "SELECT USER_ID, NAME, ROLE FROM MEMBERSHIPS WHERE WORKSPACE_ID = ? AND USER_ID = ? AND ACTIVE = TRUE",
    [actor.workspaceId, actor.userId],
  );
  const member = row ? mapMembership(row) : null;
  requireMembership(member);
  return member;
}
export async function membersFor(sql: SqlSession, actor: Actor) {
  return (
    await sql.query(
      "SELECT USER_ID, NAME, ROLE FROM MEMBERSHIPS WHERE WORKSPACE_ID = ? AND ACTIVE = TRUE ORDER BY NAME LIMIT 100",
      [actor.workspaceId],
    )
  ).map(mapMembership);
}
export const requestSelect = `SELECT R.*, M.NAME AS REQUESTER_NAME, O.NAME AS OWNER_NAME FROM REQUESTS R
  JOIN MEMBERSHIPS M ON M.WORKSPACE_ID = R.WORKSPACE_ID AND M.USER_ID = R.REQUESTER_ID
  LEFT JOIN MEMBERSHIPS O ON O.WORKSPACE_ID = R.WORKSPACE_ID AND O.USER_ID = R.OWNER_ID`;
export function mapRequest(row: Row): RequestRecord {
  return {
    id: String(row.ID),
    workspaceId: String(row.WORKSPACE_ID),
    title: String(row.TITLE),
    businessQuestion: String(row.BUSINESS_QUESTION),
    reportingPeriod: String(row.REPORTING_PERIOD ?? ""),
    dataset: String(row.DATASET ?? ""),
    customValues: JSON.parse(String(row.CUSTOM_VALUES_JSON || "{}")),
    requesterId: String(row.REQUESTER_ID),
    requesterName: String(row.REQUESTER_NAME),
    ownerId: row.OWNER_ID ? String(row.OWNER_ID) : null,
    ownerName: row.OWNER_NAME ? String(row.OWNER_NAME) : null,
    priority: row.PRIORITY as RequestRecord["priority"],
    status: row.STATUS as RequestRecord["status"],
    dueAt: row.DUE_AT ? String(row.DUE_AT).slice(0, 10) : null,
    version: Number(row.VERSION),
    createdAt: fromTimestamp(row.CREATED_AT),
    updatedAt: fromTimestamp(row.UPDATED_AT),
  };
}
function scope(member: Membership): { sql: string; values: string[] } {
  return member.role === "requester"
    ? { sql: " AND R.REQUESTER_ID = ?", values: [member.userId] }
    : { sql: "", values: [] };
}
export async function getRequest(
  sql: SqlSession,
  actor: Actor,
  member: Membership,
  id: string,
) {
  const filter = scope(member);
  const [row] = await sql.query(
    `${requestSelect} WHERE R.WORKSPACE_ID = ? AND R.ID = ?${filter.sql}`,
    [actor.workspaceId, id, ...filter.values],
  );
  if (!row) throw new DomainError("NOT_FOUND", "Request not found.", 404);
  return mapRequest(row);
}
export function visibleRequest(member: Membership, request: RequestRecord) {
  if (member.role !== "requester") return request;
  const safe: Partial<RequestRecord> = { ...request };
  delete safe.priority;
  return safe as Omit<RequestRecord, "priority">;
}
export function requestFilter(member: Membership, query: DeskQuery) {
  const filter = scope(member);
  if (query.status !== "all") {
    filter.sql += " AND R.STATUS = ?";
    filter.values.push(query.status);
  }
  if (query.search) {
    filter.sql +=
      " AND INSTR(LOWER(R.TITLE || ' ' || R.BUSINESS_QUESTION || ' ' || M.NAME || ' ' || COALESCE(O.NAME, '') || ' ' || COALESCE(R.DATASET, '') || ' ' || COALESCE(R.REPORTING_PERIOD, '')), LOWER(?)) > 0";
    filter.values.push(query.search);
  }
  return filter;
}
export function sampleSnapshot(): DeskSnapshot {
  if (!localDemoEnabled())
    throw new DomainError(
      "DEMO_DISABLED",
      "Sample workspaces are disabled.",
      404,
    );
  return {
    mode: "preview",
    refreshIntervalMs: 3000,
    tool: { revision: 1, spec: dataRequestTemplate, publishedAt: null },
    membership: null,
    requests: sampleRequests,
    members: personas.map((p) => ({
      userId: p.id,
      name: p.name,
      role: p.role,
    })),
  };
}
export async function snapshot(
  actor: Actor | null,
  input: Partial<DeskQuery> = {},
): Promise<DeskSnapshot> {
  const query = deskQuerySchema.parse(input);
  if (!isConfigured()) {
    if (
      !localDemoEnabled() ||
      process.env.EXASOL_HOST ||
      process.env.EXASOL_USER ||
      process.env.EXASOL_PASSWORD
    )
      throw new DatabaseUnavailable(
        "Exasol configuration is incomplete. Set host, user, and password.",
      );
    return sampleSnapshot();
  }
  if (!actor)
    return { mode: "connected", membership: null, requests: [], members: [] };
  return readDatabase(async (sql) => {
    const member = await membership(sql, actor),
      filter = requestFilter(member, query);
    const requests = (
      await sql.query(
        `${requestSelect} WHERE R.WORKSPACE_ID = ?${filter.sql} ORDER BY R.CREATED_AT DESC, R.ID LIMIT 26 OFFSET ${query.page * 25}`,
        [actor.workspaceId, ...filter.values],
      )
    ).map(mapRequest);
    return {
      mode: "connected",
      workspace: {
        id: actor.workspaceId,
        name: String(
          (
            await sql.query("SELECT NAME FROM WORKSPACES WHERE ID = ?", [
              actor.workspaceId,
            ])
          )[0]?.NAME || "Workspace",
        ),
      },
      refreshIntervalMs: (() => {
        const value = Number(process.env.LOOM_POLL_INTERVAL_MS || 3000);
        return Number.isInteger(value) && value >= 1000 && value <= 30000
          ? value
          : 3000;
      })(),
      membership: member,
      settings: await settingsFor(sql, actor),
      tool: await publishedTool(sql, actor),
      page: { index: query.page, size: 25, hasMore: requests.length > 25 },
      requests: requests.slice(0, 25).map((r) => visibleRequest(member, r)),
      members: member.role === "requester" ? [] : await membersFor(sql, actor),
    };
  });
}
export async function details(actor: Actor, id: string) {
  return readDatabase(async (sql) => {
    const member = await membership(sql, actor),
      request = await getRequest(sql, actor, member, id);
    const comments = await sql.query(
      `SELECT C.ID,C.BODY,C.VISIBILITY,C.CREATED_AT,M.NAME FROM COMMENTS C JOIN MEMBERSHIPS M ON M.WORKSPACE_ID=C.WORKSPACE_ID AND M.USER_ID=C.AUTHOR_ID WHERE C.WORKSPACE_ID = ? AND C.REQUEST_ID = ?${member.role === "requester" ? " AND C.VISIBILITY = 'requester_visible'" : ""} ORDER BY C.CREATED_AT,C.ID LIMIT 100`,
      [actor.workspaceId, id],
    );
    const activity =
      member.role === "requester"
        ? []
        : await sql.query(
            "SELECT A.ID,A.ACTION_KIND,A.VERSION,A.CREATED_AT,M.NAME FROM AUDIT_EVENTS A JOIN MEMBERSHIPS M ON M.WORKSPACE_ID=A.WORKSPACE_ID AND M.USER_ID=A.ACTOR_ID WHERE A.WORKSPACE_ID = ? AND A.REQUEST_ID = ? ORDER BY A.CREATED_AT DESC,A.ID LIMIT 100",
            [actor.workspaceId, id],
          );
    return {
      request: visibleRequest(member, request),
      membership: member,
      tool: await publishedTool(sql, actor),
      comments: comments.map((r) => ({
        id: String(r.ID),
        body: String(r.BODY),
        visibility: r.VISIBILITY,
        authorName: String(r.NAME),
        createdAt: fromTimestamp(r.CREATED_AT),
      })),
      activity: activity.map((r) => ({
        id: String(r.ID),
        action: String(r.ACTION_KIND),
        version: Number(r.VERSION),
        actorName: String(r.NAME),
        createdAt: fromTimestamp(r.CREATED_AT),
      })),
    };
  });
}
export async function analytics(actor: Actor) {
  return readDatabase(async (sql) => {
    const member = await membership(sql, actor);
    if (member.role === "requester")
      throw new DomainError(
        "ACCESS_DENIED",
        "Internal queue metrics are restricted to teammates.",
        403,
      );
    return queueSummary(sql, actor);
  });
}
function assertWriter(member: Membership, command?: Command) {
  if (member.role === "viewer")
    throw new DomainError(
      "ACCESS_DENIED",
      "Viewers cannot change requests.",
      403,
    );
  if (
    command &&
    !canOperate(member) &&
    ((command.type !== "edit_description" && command.type !== "add_comment") ||
      (command.type === "add_comment" && command.visibility === "internal"))
  )
    throw new DomainError(
      "ACCESS_DENIED",
      "This action requires an owner or operator.",
      403,
    );
}
export function digest(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
export async function receipt<T = RequestRecord>(
  sql: SqlSession,
  actor: Actor,
  commandId: string,
  hash: string,
) {
  const [row] = await sql.query(
    "SELECT ACTOR_ID,PAYLOAD_HASH,RESULT_JSON FROM COMMAND_RECEIPTS WHERE WORKSPACE_ID = ? AND COMMAND_ID = ?",
    [actor.workspaceId, commandId],
  );
  if (!row) {
    const [generation] = await sql.query(
      "SELECT ACTOR_ID,PAYLOAD_HASH FROM TOOL_GENERATIONS WHERE WORKSPACE_ID = ? AND COMMAND_ID = ?",
      [actor.workspaceId, commandId],
    );
    if (
      generation &&
      (generation.ACTOR_ID !== actor.userId || generation.PAYLOAD_HASH !== hash)
    )
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "This command ID was already reserved for a different action.",
        409,
      );
    return null;
  }
  if (row.ACTOR_ID !== actor.userId || row.PAYLOAD_HASH !== hash)
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "This command ID was already used for a different action.",
      409,
    );
  return JSON.parse(String(row.RESULT_JSON)) as T;
}
async function recordChange(
  sql: SqlSession,
  actor: Actor,
  request: RequestRecord,
  commandId: string,
  hash: string,
  action: string,
  saveReceipt = true,
) {
  const now = sqlTimestamp(request.updatedAt),
    eventId = randomUUID();
  await sql.execute(
    "INSERT INTO REQUEST_EVENTS (WORKSPACE_ID,ID,REQUEST_ID,ACTOR_ID,ACTION_KIND,VERSION,STATUS,SNAPSHOT_JSON,CREATED_AT) VALUES (?,?,?,?,?,?,?,?,?)",
    [
      actor.workspaceId,
      eventId,
      request.id,
      actor.userId,
      action,
      request.version,
      request.status,
      JSON.stringify(request),
      now,
    ],
  );
  await sql.execute(
    "INSERT INTO AUDIT_EVENTS (WORKSPACE_ID,ID,REQUEST_ID,ACTOR_ID,COMMAND_ID,ACTION_KIND,VERSION,CREATED_AT) VALUES (?,?,?,?,?,?,?,?)",
    [
      actor.workspaceId,
      eventId,
      request.id,
      actor.userId,
      commandId,
      action,
      request.version,
      now,
    ],
  );
  await sql.execute(
    "INSERT INTO OUTBOX_EVENTS (WORKSPACE_ID,ID,REQUEST_ID,VERSION,CREATED_AT) VALUES (?,?,?,?,?)",
    [actor.workspaceId, eventId, request.id, request.version, now],
  );
  if (saveReceipt)
    await sql.execute(
      "INSERT INTO COMMAND_RECEIPTS (WORKSPACE_ID,COMMAND_ID,ACTOR_ID,PAYLOAD_HASH,RESULT_JSON,CREATED_AT) VALUES (?,?,?,?,?,?)",
      [
        actor.workspaceId,
        commandId,
        actor.userId,
        hash,
        JSON.stringify(request),
        now,
      ],
    );
}
export async function createRequest(
  actor: Actor,
  commandId: string,
  values: Intake,
  expectedToolRevision?: number,
) {
  const hash = digest({
    type: "create",
    values,
    ...(expectedToolRevision === undefined ? {} : { expectedToolRevision }),
  });
  return writeDatabase(async (sql) => {
    const member = await membership(sql, actor);
    assertWriter(member);
    const existing = await receipt(sql, actor, commandId, hash);
    if (existing) {
      await getRequest(sql, actor, member, existing.id);
      return visibleRequest(member, existing);
    }
    await assertToolRevision(sql, actor, expectedToolRevision);
    const request = await insertRequest(
      sql,
      actor,
      member,
      commandId,
      hash,
      values,
    );
    return visibleRequest(member, request);
  });
}
// Call only inside an authorized transaction; imports share its audit/outbox path.
export async function insertRequest(
  sql: SqlSession,
  actor: Actor,
  member: Membership,
  commandId: string,
  hash: string,
  values: Intake,
  imported = false,
) {
  const { spec } = await publishedTool(sql, actor);
  assertToolAction(spec, "request.create");
  assertToolValues(spec, values);
  const now = new Date().toISOString();
  const request: RequestRecord = {
    ...values,
    id: randomUUID(),
    workspaceId: actor.workspaceId,
    requesterId: actor.userId,
    requesterName: member.name,
    ownerId: null,
    ownerName: null,
    priority: "normal",
    status:
      imported && toolRequirements(spec, values).length ? "needs_info" : "new",
    dueAt: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  assertRecordSize(request);
  await sql.execute(
    "INSERT INTO REQUESTS (WORKSPACE_ID,ID,REQUESTER_ID,TITLE,BUSINESS_QUESTION,REPORTING_PERIOD,DATASET,CUSTOM_VALUES_JSON,OWNER_ID,PRIORITY,STATUS,DUE_AT,VERSION,CREATED_AT,UPDATED_AT) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [
      actor.workspaceId,
      request.id,
      actor.userId,
      values.title,
      values.businessQuestion,
      values.reportingPeriod || null,
      values.dataset || null,
      JSON.stringify(values.customValues || {}),
      null,
      "normal",
      request.status,
      null,
      1,
      sqlTimestamp(now),
      sqlTimestamp(now),
    ],
  );
  await recordChange(
    sql,
    actor,
    request,
    commandId,
    hash,
    imported ? "imported" : "created",
    !imported,
  );
  return request;
}

export async function mutateRequest(
  actor: Actor,
  id: string,
  commandId: string,
  expectedVersion: number,
  command: Command,
  expectedToolRevision?: number,
) {
  const hash = digest({
    id,
    expectedVersion,
    command,
    ...(expectedToolRevision === undefined ? {} : { expectedToolRevision }),
  });
  return writeDatabase(async (sql) => {
    const member = await membership(sql, actor);
    assertWriter(member, command);
    const request = await getRequest(sql, actor, member, id);
    assertReadable(member, request);
    const existing = await receipt(sql, actor, commandId, hash);
    if (existing) return visibleRequest(member, existing);
    await assertToolRevision(sql, actor, expectedToolRevision);
    const next = await applyRequestCommand(
      sql,
      actor,
      member,
      request,
      commandId,
      hash,
      expectedVersion,
      command,
    );
    return visibleRequest(member, next);
  });
}
// Shared transactional executor for manual commands and exact reviewed proposal actions.
export async function applyRequestCommand(
  sql: SqlSession,
  actor: Actor,
  member: Membership,
  request: RequestRecord,
  commandId: string,
  hash: string,
  expectedVersion: number,
  command: Command,
  saveReceipt = true,
) {
  assertWriter(member, command);
  assertReadable(member, request);
  const id = request.id;
  if (request.version !== expectedVersion)
    throw new DomainError(
      "VERSION_CONFLICT",
      "This request changed. Refresh its details before saving again.",
      409,
    );
  const next = applyCommand(
    member,
    request,
    command,
    await membersFor(sql, actor),
  );
  const { spec } = await publishedTool(sql, actor);
  assertToolCommand(spec, command, next);
  assertRecordSize(next);
  const changed = await sql.execute(
    "UPDATE REQUESTS SET TITLE=?,BUSINESS_QUESTION=?,REPORTING_PERIOD=?,DATASET=?,CUSTOM_VALUES_JSON=?,OWNER_ID=?,PRIORITY=?,STATUS=?,DUE_AT=?,VERSION=?,UPDATED_AT=? WHERE WORKSPACE_ID=? AND ID=? AND VERSION=?",
    [
      next.title,
      next.businessQuestion,
      next.reportingPeriod || null,
      next.dataset || null,
      JSON.stringify(next.customValues || {}),
      next.ownerId,
      next.priority,
      next.status,
      next.dueAt,
      next.version,
      sqlTimestamp(next.updatedAt),
      actor.workspaceId,
      id,
      expectedVersion,
    ],
  );
  if (changed !== 1)
    throw new DomainError(
      "VERSION_CONFLICT",
      "This request changed. Refresh before saving.",
      409,
    );
  if (command.type === "add_comment")
    await sql.execute(
      "INSERT INTO COMMENTS (WORKSPACE_ID,ID,REQUEST_ID,AUTHOR_ID,BODY,VISIBILITY,CREATED_AT) VALUES (?,?,?,?,?,?,?)",
      [
        actor.workspaceId,
        randomUUID(),
        id,
        actor.userId,
        command.body,
        command.visibility,
        sqlTimestamp(next.updatedAt),
      ],
    );
  await recordChange(
    sql,
    actor,
    next,
    commandId,
    hash,
    command.type,
    saveReceipt,
  );
  return next;
}

export function assertRecordSize(request: RequestRecord) {
  if (JSON.stringify(request).length > 19_000)
    throw new DomainError(
      "RECORD_TOO_LARGE",
      "The combined request fields are too large. Shorten the description or optional details before saving.",
      422,
    );
}

async function assertToolRevision(
  sql: SqlSession,
  actor: Actor,
  expected?: number,
) {
  const current = await publishedTool(sql, actor);
  if (expected !== undefined && expected !== current.revision)
    throw new DomainError(
      "TOOL_REVISION_CONFLICT",
      "The tool changed while you were editing. Your input is preserved; close and reopen this form to review the current fields before saving.",
      409,
    );
  return current;
}

export const defaultWorkspace = workspaceId;
export type DetailsResponse = Omit<RequestDetails, "request"> & {
  request: ReturnType<typeof visibleRequest>;
};
