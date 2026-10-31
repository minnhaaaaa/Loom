import "server-only";
import { randomUUID } from "node:crypto";
import {
  acceptInvitationSchema,
  createWorkspaceSchema,
  invitationRoles,
  type Actor,
  type InvitationCredentials,
  type InvitationPreview,
  type InvitationRole,
  type Role,
  type SessionGrant,
  type WorkspaceAccess,
  type WorkspaceInvitation,
  type WorkspaceMember,
  type WorkspaceSummary,
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
import { membership, digest, receipt } from "./desk";
import { createStoredSession, insertAccount } from "./accounts";
import {
  hashPassword,
  hashToken,
  invitationToken,
  validInvitationToken,
} from "./identity-crypto";

function mapMember(row: Row): WorkspaceMember {
  return {
    userId: String(row.USER_ID),
    name: String(row.NAME),
    role: row.ROLE as Role,
    active: row.ACTIVE === true,
    version: Number(row.VERSION),
  };
}
function mapInvitation(row: Row): WorkspaceInvitation {
  return {
    id: String(row.ID),
    role: row.ROLE as InvitationRole,
    state: row.LIFECYCLE as WorkspaceInvitation["state"],
    version: Number(row.VERSION),
    createdAt: fromTimestamp(row.CREATED_AT),
    expiresAt: fromTimestamp(row.EXPIRES_AT),
    createdBy: String(row.CREATED_BY),
  };
}
async function requireOwner(sql: SqlSession, actor: Actor) {
  const member = await membership(sql, actor);
  if (member.role !== "owner")
    throw new DomainError(
      "ACCESS_DENIED",
      "Only a workspace owner can manage access.",
      403,
    );
  return member;
}
async function event(
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
async function invitationById(sql: SqlSession, actor: Actor, id: string) {
  const [row] = await sql.query(
    "SELECT * FROM WORKSPACE_INVITATIONS WHERE WORKSPACE_ID=? AND ID=?",
    [actor.workspaceId, id],
  );
  if (!row) throw new DomainError("NOT_FOUND", "Invitation not found.", 404);
  return mapInvitation(row);
}
async function validInvitation(sql: SqlSession, token: string) {
  if (!validInvitationToken(token))
    throw new DomainError(
      "INVITATION_UNAVAILABLE",
      "This invitation is invalid, expired, or no longer available.",
      404,
    );
  const [row] = await sql.query(
    "SELECT I.*,W.NAME AS WORKSPACE_NAME FROM WORKSPACE_INVITATIONS I JOIN WORKSPACES W ON W.ID=I.WORKSPACE_ID JOIN MEMBERSHIPS M ON M.WORKSPACE_ID=I.WORKSPACE_ID AND M.USER_ID=I.CREATED_BY WHERE I.TOKEN_HASH=? AND I.LIFECYCLE='pending' AND I.EXPIRES_AT>? AND M.ACTIVE=TRUE AND M.ROLE='owner'",
    [hashToken(token), sqlTimestamp(new Date().toISOString())],
  );
  if (!row)
    throw new DomainError(
      "INVITATION_UNAVAILABLE",
      "This invitation is invalid, expired, or no longer available.",
      404,
    );
  return row;
}
export async function createWorkspace(
  actor: Actor,
  commandId: string,
  name: string,
): Promise<WorkspaceSummary> {
  const values = createWorkspaceSchema.parse({ commandId, name }),
    hash = digest({ type: "workspace-create", name: values.name });
  return writeDatabase(async (sql) => {
    const [account] = await sql.query(
      "SELECT NAME FROM AUTH_USERS WHERE ID=?",
      [actor.userId],
    );
    const displayName = account
      ? String(account.NAME)
      : (await membership(sql, actor)).name;
    let saved: WorkspaceSummary | null = null;
    if (account) {
      const [command] = await sql.query(
        "SELECT PAYLOAD_HASH,RESULT_JSON FROM ACCOUNT_COMMANDS WHERE USER_ID=? AND COMMAND_ID=?",
        [actor.userId, commandId],
      );
      if (command && command.PAYLOAD_HASH !== hash)
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          "This account command ID was already used for a different action.",
          409,
        );
      if (command)
        saved = JSON.parse(String(command.RESULT_JSON)) as WorkspaceSummary;
    } else saved = await receipt<WorkspaceSummary>(sql, actor, commandId, hash);
    if (saved) return saved;
    const id = randomUUID();
    await sql.execute("INSERT INTO WORKSPACES (ID,NAME) VALUES (?,?)", [
      id,
      values.name,
    ]);
    await sql.execute(
      "INSERT INTO MEMBERSHIPS (WORKSPACE_ID,USER_ID,NAME,ROLE,ACTIVE,VERSION) VALUES (?,?,?,'owner',TRUE,1)",
      [id, actor.userId, displayName],
    );
    await event(sql, { ...actor, workspaceId: id }, "workspace_created", id, 1);
    const result: WorkspaceSummary = { id, name: values.name, role: "owner" };
    if (account)
      await sql.execute(
        "INSERT INTO ACCOUNT_COMMANDS (USER_ID,COMMAND_ID,PAYLOAD_HASH,RESULT_JSON,CREATED_AT) VALUES (?,?,?,?,?)",
        [
          actor.userId,
          commandId,
          hash,
          JSON.stringify(result),
          sqlTimestamp(new Date().toISOString()),
        ],
      );
    else await saveReceipt(sql, actor, commandId, hash, result);
    return result;
  });
}
export async function workspaceAccess(actor: Actor): Promise<WorkspaceAccess> {
  return readDatabase(async (sql) => {
    await membership(sql, actor);
    const [current] = await sql.query(
      "SELECT M.*,W.NAME AS WORKSPACE_NAME FROM MEMBERSHIPS M JOIN WORKSPACES W ON W.ID=M.WORKSPACE_ID WHERE M.WORKSPACE_ID=? AND M.USER_ID=? AND M.ACTIVE=TRUE",
      [actor.workspaceId, actor.userId],
    );
    if (!current)
      throw new DomainError(
        "ACCESS_DENIED",
        "Your workspace membership changed. Refresh before continuing.",
        403,
      );
    const workspace = {
        id: actor.workspaceId,
        name: String(current.WORKSPACE_NAME),
      },
      currentMember = mapMember(current);
    if (currentMember.role !== "owner")
      return {
        workspace,
        membership: currentMember,
        members: [],
        invitations: [],
      };
    const members = await sql.query(
      "SELECT USER_ID,NAME,ROLE,ACTIVE,VERSION FROM MEMBERSHIPS WHERE WORKSPACE_ID=? ORDER BY NAME,USER_ID LIMIT 201",
      [actor.workspaceId],
    );
    if (members.length > 200)
      throw new DomainError(
        "MEMBER_LIMIT",
        "Access management currently supports up to 200 members per workspace.",
        422,
      );
    const invitations = await sql.query(
      "SELECT * FROM WORKSPACE_INVITATIONS WHERE WORKSPACE_ID=? ORDER BY CREATED_AT DESC,ID LIMIT 100",
      [actor.workspaceId],
    );
    return {
      workspace,
      membership: currentMember,
      members: members.map(mapMember),
      invitations: invitations.map(mapInvitation),
    };
  });
}
export async function createInvitation(
  actor: Actor,
  commandId: string,
  role: InvitationRole,
): Promise<WorkspaceInvitation & { token: string }> {
  if (!(invitationRoles as readonly string[]).includes(role))
    throw new DomainError(
      "INVALID_INVITATION_ROLE",
      "Invitations can grant operator, requester, or viewer access.",
      422,
    );
  const hash = digest({ type: "invitation-create", role });
  return writeDatabase(async (sql) => {
    await requireOwner(sql, actor);
    const saved = await receipt<{ id: string }>(sql, actor, commandId, hash);
    if (saved)
      return {
        ...(await invitationById(sql, actor, saved.id)),
        token: invitationToken(saved.id),
      };
    const [count] = await sql.query(
      "SELECT COUNT(*) AS TOTAL FROM WORKSPACE_INVITATIONS WHERE WORKSPACE_ID=? AND LIFECYCLE='pending' AND EXPIRES_AT>?",
      [actor.workspaceId, sqlTimestamp(new Date().toISOString())],
    );
    if (Number(count.TOTAL) >= 50)
      throw new DomainError(
        "INVITATION_LIMIT",
        "Revoke an unused invitation before creating more. At most 50 current invitations are supported.",
        422,
      );
    const id = randomUUID(),
      token = invitationToken(id),
      now = new Date().toISOString();
    await sql.execute(
      "INSERT INTO WORKSPACE_INVITATIONS (WORKSPACE_ID,ID,TOKEN_HASH,ROLE,LIFECYCLE,VERSION,CREATED_BY,CREATED_AT,EXPIRES_AT) VALUES (?,?,?,?,'pending',1,?,?,?)",
      [
        actor.workspaceId,
        id,
        hashToken(token),
        role,
        actor.userId,
        sqlTimestamp(now),
        sqlTimestamp(new Date(Date.now() + 24 * 60 * 60_000).toISOString()),
      ],
    );
    await event(sql, actor, "invitation_created", id, 1);
    await saveReceipt(sql, actor, commandId, hash, { id });
    return { ...(await invitationById(sql, actor, id)), token };
  });
}
export async function invitationPreview(
  token: string,
): Promise<InvitationPreview> {
  return readDatabase(async (sql) => {
    const row = await validInvitation(sql, token);
    return {
      workspace: {
        id: String(row.WORKSPACE_ID),
        name: String(row.WORKSPACE_NAME),
      },
      role: row.ROLE as InvitationRole,
      expiresAt: fromTimestamp(row.EXPIRES_AT),
    };
  });
}
export async function acceptInvitation(
  token: string,
  identity: InvitationCredentials | string,
): Promise<SessionGrant> {
  // Validate before spending password-derivation work, then recheck in the write transaction.
  await readDatabase((sql) => validInvitation(sql, token));
  const values =
    typeof identity === "string"
      ? null
      : acceptInvitationSchema.parse(identity);
  if (values) {
    const [existing] = await readDatabase((sql) =>
      sql.query("SELECT USER_ID FROM AUTH_IDENTITIES WHERE EMAIL=?", [
        values.email,
      ]),
    );
    if (existing)
      throw new DomainError(
        "ACCOUNT_EXISTS",
        "This email already has an account. Sign in before accepting the invitation.",
        409,
      );
  }
  const passwordHash = values ? await hashPassword(values.password) : null;
  return writeDatabase(async (sql) => {
    const invitation = await validInvitation(sql, token),
      workspaceId = String(invitation.WORKSPACE_ID);
    let userId: string, displayName: string;
    if (values) {
      userId = await insertAccount(sql, values, passwordHash!);
      displayName = values.name;
    } else {
      userId = String(identity);
      const [account] = await sql.query(
        "SELECT NAME FROM AUTH_USERS WHERE ID=?",
        [userId],
      );
      if (!account)
        throw new DomainError(
          "ACCOUNT_REQUIRED",
          "Sign in with a registered account to accept this invitation.",
          403,
        );
      displayName = String(account.NAME);
    }
    const [existing] = await sql.query(
      "SELECT USER_ID,ACTIVE FROM MEMBERSHIPS WHERE WORKSPACE_ID=? AND USER_ID=?",
      [workspaceId, userId],
    );
    if (existing?.ACTIVE === true)
      throw new DomainError(
        "ALREADY_MEMBER",
        "You already have active access to this workspace.",
        409,
      );
    if (existing)
      await sql.execute(
        'UPDATE MEMBERSHIPS SET "ROLE"=?,ACTIVE=TRUE,VERSION=VERSION+1,NAME=? WHERE WORKSPACE_ID=? AND USER_ID=?',
        [invitation.ROLE, displayName, workspaceId, userId],
      );
    else
      await sql.execute(
        "INSERT INTO MEMBERSHIPS (WORKSPACE_ID,USER_ID,NAME,ROLE,ACTIVE,VERSION) VALUES (?,?,?,?,TRUE,1)",
        [workspaceId, userId, displayName, invitation.ROLE],
      );
    const changed = await sql.execute(
      "UPDATE WORKSPACE_INVITATIONS SET LIFECYCLE='accepted',ACCEPTED_BY=?,VERSION=VERSION+1 WHERE WORKSPACE_ID=? AND ID=? AND VERSION=? AND LIFECYCLE='pending'",
      [userId, workspaceId, invitation.ID, invitation.VERSION],
    );
    if (changed !== 1)
      throw new DomainError(
        "INVITATION_CONFLICT",
        "This invitation was already used or changed. Ask for a new invitation.",
        409,
      );
    await event(
      sql,
      { userId, workspaceId },
      "invitation_accepted",
      String(invitation.ID),
      Number(invitation.VERSION) + 1,
    );
    return createStoredSession(sql, userId, workspaceId);
  });
}
export async function changeMembership(
  actor: Actor,
  userId: string,
  commandId: string,
  expectedVersion: number,
  role: Role,
  active: boolean,
): Promise<WorkspaceMember> {
  if (typeof active !== "boolean")
    throw new DomainError(
      "INVALID_MEMBERSHIP_ACTIVE",
      "Membership active status must be true or false.",
      422,
    );
  const hash = digest({
    type: "membership-change",
    userId,
    expectedVersion,
    role,
    active,
  });
  if (!["owner", "operator", "requester", "viewer"].includes(role))
    throw new DomainError(
      "INVALID_ROLE",
      "Choose a supported workspace role.",
      422,
    );
  return writeDatabase(async (sql) => {
    await requireOwner(sql, actor);
    const saved = await receipt<WorkspaceMember>(sql, actor, commandId, hash);
    if (saved) return saved;
    const [row] = await sql.query(
      "SELECT USER_ID,NAME,ROLE,ACTIVE,VERSION FROM MEMBERSHIPS WHERE WORKSPACE_ID=? AND USER_ID=?",
      [actor.workspaceId, userId],
    );
    if (!row)
      throw new DomainError("NOT_FOUND", "Workspace member not found.", 404);
    const previous = mapMember(row);
    if (previous.version !== expectedVersion)
      throw new DomainError(
        "VERSION_CONFLICT",
        "This membership changed. Refresh access settings before saving.",
        409,
      );
    if (
      previous.active &&
      previous.role === "owner" &&
      (!active || role !== "owner")
    ) {
      const [owners] = await sql.query(
        "SELECT COUNT(*) AS TOTAL FROM MEMBERSHIPS WHERE WORKSPACE_ID=? AND ROLE='owner' AND ACTIVE=TRUE",
        [actor.workspaceId],
      );
      if (Number(owners.TOTAL) <= 1)
        throw new DomainError(
          "LAST_OWNER",
          "Promote another active member to owner before removing or demoting the last owner.",
          422,
        );
    }
    if (previous.role === role && previous.active === active)
      throw new DomainError(
        "NO_MEMBERSHIP_CHANGES",
        "This member already has the selected access.",
        422,
      );
    const changed = await sql.execute(
      `UPDATE MEMBERSHIPS SET "ROLE"=?,ACTIVE=${active ? "TRUE" : "FALSE"},VERSION=VERSION+1 WHERE WORKSPACE_ID=? AND USER_ID=? AND VERSION=?`,
      [role, actor.workspaceId, userId, expectedVersion],
    );
    if (changed !== 1)
      throw new DomainError(
        "VERSION_CONFLICT",
        "This membership changed. Refresh access settings.",
        409,
      );
    const result: WorkspaceMember = {
      ...previous,
      role,
      active,
      version: previous.version + 1,
    };
    await event(
      sql,
      actor,
      active ? "membership_changed" : "membership_revoked",
      userId,
      result.version,
    );
    await saveReceipt(sql, actor, commandId, hash, result);
    return result;
  });
}
export async function revokeInvitation(
  actor: Actor,
  id: string,
  commandId: string,
  expectedVersion: number,
): Promise<WorkspaceInvitation> {
  const hash = digest({ type: "invitation-revoke", id, expectedVersion });
  return writeDatabase(async (sql) => {
    await requireOwner(sql, actor);
    const saved = await receipt<WorkspaceInvitation>(
      sql,
      actor,
      commandId,
      hash,
    );
    if (saved) return saved;
    const current = await invitationById(sql, actor, id);
    if (current.version !== expectedVersion)
      throw new DomainError(
        "VERSION_CONFLICT",
        "This invitation changed. Refresh access settings.",
        409,
      );
    if (current.state !== "pending")
      throw new DomainError(
        "INVITATION_CONFLICT",
        "Only unused invitations can be revoked.",
        409,
      );
    const changed = await sql.execute(
      "UPDATE WORKSPACE_INVITATIONS SET LIFECYCLE='revoked',VERSION=VERSION+1 WHERE WORKSPACE_ID=? AND ID=? AND VERSION=? AND LIFECYCLE='pending'",
      [actor.workspaceId, id, expectedVersion],
    );
    if (changed !== 1)
      throw new DomainError(
        "VERSION_CONFLICT",
        "This invitation changed. Refresh access settings.",
        409,
      );
    const result: WorkspaceInvitation = {
      ...current,
      state: "revoked",
      version: current.version + 1,
    };
    await event(sql, actor, "invitation_revoked", id, result.version);
    await saveReceipt(sql, actor, commandId, hash, result);
    return result;
  });
}
