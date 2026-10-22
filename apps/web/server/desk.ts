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
} from "@loom/contracts";
import { sampleRequests } from "@loom/contracts/fixtures";
import {
  applyCommand,
  assertReadable,
  canOperate,
  DomainError,
  requireMembership,
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
async function membersFor(sql: SqlSession, actor: Actor) {
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
async function getRequest(
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
export async function snapshot(
  actor: Actor | null,
  input: Partial<DeskQuery> = {},
): Promise<DeskSnapshot> {
  const query = deskQuerySchema.parse(input);
  if (!isConfigured()) {
    if (
      process.env.EXASOL_HOST ||
      process.env.EXASOL_USER ||
      process.env.EXASOL_PASSWORD
    )
      throw new DatabaseUnavailable(
        "Exasol configuration is incomplete. Set host, user, and password.",
      );
    return {
      mode: "preview",
      membership: null,
      requests: sampleRequests,
      members: personas.map((p) => ({
        userId: p.id,
        name: p.name,
        role: p.role,
      })),
    };
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
      membership: member,
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
    const activity = await sql.query(
      "SELECT A.ID,A.ACTION_KIND,A.VERSION,A.CREATED_AT,M.NAME FROM AUDIT_EVENTS A JOIN MEMBERSHIPS M ON M.WORKSPACE_ID=A.WORKSPACE_ID AND M.USER_ID=A.ACTOR_ID WHERE A.WORKSPACE_ID = ? AND A.REQUEST_ID = ? ORDER BY A.CREATED_AT DESC,A.ID LIMIT 100",
      [actor.workspaceId, id],
    );
    return {
      request: visibleRequest(member, request),
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
  if (!row) return null;
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
) {
  const hash = digest({ type: "create", values });
  return writeDatabase(async (sql) => {
    const member = await membership(sql, actor);
    assertWriter(member);
    const existing = await receipt(sql, actor, commandId, hash);
    if (existing) {
      await getRequest(sql, actor, member, existing.id);
      return visibleRequest(member, existing);
    }
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
      imported && (!values.dataset || !values.reportingPeriod)
        ? "needs_info"
        : "new",
    dueAt: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  await sql.execute(
    "INSERT INTO REQUESTS (WORKSPACE_ID,ID,REQUESTER_ID,TITLE,BUSINESS_QUESTION,REPORTING_PERIOD,DATASET,OWNER_ID,PRIORITY,STATUS,DUE_AT,VERSION,CREATED_AT,UPDATED_AT) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [
      actor.workspaceId,
      request.id,
      actor.userId,
      values.title,
      values.businessQuestion,
      values.reportingPeriod || null,
      values.dataset || null,
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
) {
  const hash = digest({ id, expectedVersion, command });
  return writeDatabase(async (sql) => {
    const member = await membership(sql, actor);
    assertWriter(member, command);
    const request = await getRequest(sql, actor, member, id);
    assertReadable(member, request);
    const existing = await receipt(sql, actor, commandId, hash);
    if (existing) return visibleRequest(member, existing);
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
    const changed = await sql.execute(
      "UPDATE REQUESTS SET TITLE=?,BUSINESS_QUESTION=?,REPORTING_PERIOD=?,DATASET=?,OWNER_ID=?,PRIORITY=?,STATUS=?,DUE_AT=?,VERSION=?,UPDATED_AT=? WHERE WORKSPACE_ID=? AND ID=? AND VERSION=?",
      [
        next.title,
        next.businessQuestion,
        next.reportingPeriod || null,
        next.dataset || null,
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
    await recordChange(sql, actor, next, commandId, hash, command.type);
    return visibleRequest(member, next);
  });
}
export const defaultWorkspace = workspaceId;
export type DetailsResponse = Omit<RequestDetails, "request"> & {
  request: ReturnType<typeof visibleRequest>;
};
