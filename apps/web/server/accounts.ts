import "server-only";
import { randomUUID } from "node:crypto";
import {
  loginAccountSchema,
  registerAccountSchema,
  type Actor,
  type AccountContext,
  type LoginInput,
  type RegistrationInput,
  type SessionGrant,
} from "@loom/contracts";
import { DomainError } from "@loom/domain";
import {
  readDatabase,
  writeDatabase,
  sqlTimestamp,
  type SqlSession,
} from "@loom/db-exasol";
import {
  hashPassword,
  verifyPassword,
  newSessionToken,
  hashToken,
  isSessionToken,
} from "./identity-crypto";

export async function createStoredSession(
  sql: SqlSession,
  userId: string,
  workspaceId: string,
): Promise<SessionGrant> {
  const token = newSessionToken(),
    now = new Date().toISOString();
  await sql.execute(
    "INSERT INTO AUTH_SESSIONS (TOKEN_HASH,USER_ID,WORKSPACE_ID,CREATED_AT,EXPIRES_AT) VALUES (?,?,?,?,?)",
    [
      hashToken(token),
      userId,
      workspaceId,
      sqlTimestamp(now),
      sqlTimestamp(new Date(Date.now() + 8 * 60 * 60_000).toISOString()),
    ],
  );
  return { token, actor: { userId, workspaceId } };
}
export async function insertAccount(
  sql: SqlSession,
  values: { name: string; email: string },
  passwordHash: string,
) {
  const [existing] = await sql.query(
    "SELECT USER_ID FROM AUTH_IDENTITIES WHERE EMAIL = ?",
    [values.email],
  );
  if (existing)
    throw new DomainError(
      "ACCOUNT_EXISTS",
      "This email already has an account. Sign in before accepting an invitation or creating another workspace.",
      409,
    );
  const id = randomUUID();
  await sql.execute(
    "INSERT INTO AUTH_USERS (ID,NAME,CREATED_AT) VALUES (?,?,?)",
    [id, values.name, sqlTimestamp(new Date().toISOString())],
  );
  await sql.execute(
    "INSERT INTO AUTH_IDENTITIES (EMAIL,USER_ID,PASSWORD_HASH) VALUES (?,?,?)",
    [values.email, id, passwordHash],
  );
  return id;
}
export async function registerAccount(
  input: RegistrationInput,
): Promise<SessionGrant> {
  if (process.env.LOOM_ALLOW_WORKSPACE_SIGNUP !== "true")
    throw new DomainError(
      "SIGNUP_DISABLED",
      "New workspace registration is disabled. Ask a workspace owner for an invitation.",
      403,
    );
  const values = registerAccountSchema.parse(input),
    passwordHash = await hashPassword(values.password);
  // Expensive password derivation happens before entering the write coordinator.
  return writeDatabase(async (sql) => {
    const userId = await insertAccount(sql, values, passwordHash),
      workspaceId = randomUUID();
    await sql.execute("INSERT INTO WORKSPACES (ID,NAME) VALUES (?,?)", [
      workspaceId,
      values.workspaceName,
    ]);
    await sql.execute(
      "INSERT INTO MEMBERSHIPS (WORKSPACE_ID,USER_ID,NAME,ROLE,ACTIVE,VERSION) VALUES (?,?,?,'owner',TRUE,1)",
      [workspaceId, userId, values.name],
    );
    await sql.execute(
      "INSERT INTO WORKSPACE_EVENTS (WORKSPACE_ID,ID,ACTOR_ID,ACTION_KIND,SUBJECT_ID,VERSION,CREATED_AT) VALUES (?,?,?,'workspace_created',?,1,?)",
      [
        workspaceId,
        randomUUID(),
        userId,
        workspaceId,
        sqlTimestamp(new Date().toISOString()),
      ],
    );
    return createStoredSession(sql, userId, workspaceId);
  });
}
export async function loginAccount(input: LoginInput): Promise<SessionGrant> {
  const values = loginAccountSchema.parse(input);
  const [identity] = await readDatabase((sql) =>
    sql.query(
      "SELECT USER_ID,PASSWORD_HASH FROM AUTH_IDENTITIES WHERE EMAIL = ?",
      [values.email],
    ),
  );
  const valid = await verifyPassword(
    values.password,
    identity ? String(identity.PASSWORD_HASH) : null,
  );
  if (!valid || !identity)
    throw new DomainError(
      "INVALID_CREDENTIALS",
      "The email or password is incorrect.",
      401,
    );
  return writeDatabase(async (sql) => {
    const [current] = await sql.query(
      "SELECT USER_ID,PASSWORD_HASH FROM AUTH_IDENTITIES WHERE EMAIL = ?",
      [values.email],
    );
    if (
      !current ||
      current.USER_ID !== identity.USER_ID ||
      current.PASSWORD_HASH !== identity.PASSWORD_HASH
    )
      throw new DomainError(
        "INVALID_CREDENTIALS",
        "The account credentials changed. Sign in again.",
        401,
      );
    const [workspace] = await sql.query(
      "SELECT M.WORKSPACE_ID FROM MEMBERSHIPS M JOIN WORKSPACES W ON W.ID=M.WORKSPACE_ID WHERE M.USER_ID=? ORDER BY M.ACTIVE DESC,W.NAME,W.ID LIMIT 1",
      [String(current.USER_ID)],
    );
    if (!workspace)
      throw new DomainError(
        "NO_ACTIVE_WORKSPACE",
        "This account has no active workspace membership. Contact a workspace owner.",
        403,
      );
    return createStoredSession(
      sql,
      String(current.USER_ID),
      String(workspace.WORKSPACE_ID),
    );
  });
}
export async function sessionActor(token: string): Promise<Actor | null> {
  if (!isSessionToken(token)) return null;
  return readDatabase(async (sql) => {
    // Authentication survives workspace revocation so the user can accept a new
    // invitation. Every business service still checks active membership.
    const [session] = await sql.query(
      "SELECT USER_ID,WORKSPACE_ID FROM AUTH_SESSIONS WHERE TOKEN_HASH=? AND EXPIRES_AT>?",
      [hashToken(token), sqlTimestamp(new Date().toISOString())],
    );
    return session
      ? {
          userId: String(session.USER_ID),
          workspaceId: String(session.WORKSPACE_ID),
        }
      : null;
  });
}
export async function revokeSession(token: string) {
  if (!isSessionToken(token)) return;
  await writeDatabase(async (sql) => {
    await sql.execute("DELETE FROM AUTH_SESSIONS WHERE TOKEN_HASH=?", [
      hashToken(token),
    ]);
  });
}
export async function selectSessionWorkspace(
  token: string,
  workspaceId: string,
): Promise<Actor> {
  if (!isSessionToken(token))
    throw new DomainError(
      "UNAUTHENTICATED",
      "Sign in to select a workspace.",
      401,
    );
  return writeDatabase(async (sql) => {
    const [session] = await sql.query(
      "SELECT USER_ID FROM AUTH_SESSIONS WHERE TOKEN_HASH=? AND EXPIRES_AT>?",
      [hashToken(token), sqlTimestamp(new Date().toISOString())],
    );
    if (!session)
      throw new DomainError(
        "UNAUTHENTICATED",
        "Your session expired. Sign in again.",
        401,
      );
    const [member] = await sql.query(
      "SELECT USER_ID FROM MEMBERSHIPS WHERE WORKSPACE_ID=? AND USER_ID=? AND ACTIVE=TRUE",
      [workspaceId, String(session.USER_ID)],
    );
    if (!member)
      throw new DomainError(
        "ACCESS_DENIED",
        "You do not have access to this workspace.",
        403,
      );
    await sql.execute(
      "UPDATE AUTH_SESSIONS SET WORKSPACE_ID=? WHERE TOKEN_HASH=?",
      [workspaceId, hashToken(token)],
    );
    return { userId: String(session.USER_ID), workspaceId };
  });
}
export async function accountContext(
  actor: Actor | null,
): Promise<AccountContext> {
  const configuration = {
    authMode:
      process.env.LOOM_AUTH_MODE === "local-demo"
        ? ("local-demo" as const)
        : ("workspace" as const),
    registrationEnabled: process.env.LOOM_ALLOW_WORKSPACE_SIGNUP === "true",
  };
  if (!actor)
    return {
      user: null,
      workspaces: [],
      currentWorkspaceId: null,
      ...configuration,
    };
  return readDatabase(async (sql) => {
    const [member] = await sql.query(
      "SELECT NAME FROM MEMBERSHIPS WHERE WORKSPACE_ID=? AND USER_ID=? AND ACTIVE=TRUE",
      [actor.workspaceId, actor.userId],
    );
    const [account] = await sql.query(
      "SELECT U.NAME,I.EMAIL FROM AUTH_USERS U LEFT JOIN AUTH_IDENTITIES I ON I.USER_ID=U.ID WHERE U.ID=?",
      [actor.userId],
    );
    if (!member && !account)
      throw new DomainError(
        "ACCESS_DENIED",
        "Your workspace access changed. Sign in again.",
        403,
      );
    const memberships = await sql.query(
      "SELECT W.ID,W.NAME,M.ROLE FROM WORKSPACES W JOIN MEMBERSHIPS M ON M.WORKSPACE_ID=W.ID WHERE M.USER_ID=? AND M.ACTIVE=TRUE ORDER BY W.NAME,W.ID LIMIT 101",
      [actor.userId],
    );
    if (memberships.length > 100)
      throw new DomainError(
        "WORKSPACE_LIMIT",
        "Account context supports up to 100 active workspaces.",
        422,
      );
    return {
      user: {
        id: actor.userId,
        name: String(account?.NAME ?? member?.NAME),
        email: account?.EMAIL ? String(account.EMAIL) : null,
      },
      workspaces: memberships.map((row) => ({
        id: String(row.ID),
        name: String(row.NAME),
        role: row.ROLE as AccountContext["workspaces"][number]["role"],
      })),
      currentWorkspaceId: member ? actor.workspaceId : null,
      ...configuration,
    };
  });
}
