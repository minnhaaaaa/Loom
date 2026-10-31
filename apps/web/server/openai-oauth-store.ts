import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Actor } from "@loom/contracts";
import { DomainError } from "@loom/domain";
import {
  readDatabase,
  writeDatabase,
  sqlTimestamp,
  fromTimestamp,
  type Row,
  type SqlSession,
} from "@loom/db-exasol";
import { membership } from "./desk";
import {
  encryptProviderCredential,
  decryptProviderCredential,
} from "./provider-config";
import { isSessionToken } from "./identity-crypto";
import { limitCredentialAttempt } from "./auth-limits";
import { openAiHostId } from "./openai-oauth-host";
import {
  OPENAI_ISSUER,
  OPENAI_SETUP_URL,
  createOpenAiTransaction,
  discoverOpenAi,
  exchangeOpenAiCode,
  hasOpenAiPlanScope,
  oauthDigest,
  openAiAuthorizationUrl,
  openAiOAuthConfig,
  refreshOpenAiTokens,
  requireOpenAiOAuthConfig,
  revokeOpenAiTokens,
  validateOpenAiCallback,
  type OpenAiIdentity,
  type OpenAiTokens,
} from "./openai-oauth";

export type OpenAiConnectionStatus = {
  configured: boolean;
  status:
    | "not_configured"
    | "not_connected"
    | "identity_verified"
    | "plan_enabled"
    | "reconnect_required";
  inferenceAvailable: boolean;
  canonicalOrigin: string | null;
  clientId: string | null;
  model: string | null;
  identity: {
    email: string | null;
    name: string | null;
    verifiedAt: string;
  } | null;
  accounts: {
    clientId: string;
    email: string | null;
    name: string | null;
    active: boolean;
  }[];
  message: string;
  setupUrl: string;
  revocationConfirmed?: boolean;
};
export type OpenAiPlanStatus = {
  planEnabled: boolean;
  model: string | null;
  clientId: string;
  subject: string;
  revision: number;
};
export type OpenAiPlanCredential = OpenAiPlanStatus & {
  accessToken: string;
  expiresAt: number;
};
const transactionSchema = z.object({
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  verifier: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  clientId: z.string(),
  redirectUri: z.string(),
  hostId: z.string(),
  expectedSubject: z.string().nullable(),
  expiresAt: z.number().int(),
});
const tokenSchema = z.object({
  idToken: z.string(),
  accessToken: z.string().nullable(),
  refreshToken: z.string().nullable(),
  scopes: z.array(z.string()),
  expiresAt: z.number(),
  earliestRefreshAt: z.number(),
  nonce: z.string(),
});
export async function assertOpenAiOwner(sql: SqlSession, actor: Actor) {
  if ((await membership(sql, actor)).role !== "owner")
    throw new DomainError(
      "ACCESS_DENIED",
      "Only company owners can manage their ChatGPT connection.",
      403,
    );
}
export async function assertOpenAiOwnerSession(
  sql: SqlSession,
  actor: Actor,
  sessionHash: string,
) {
  await assertOpenAiOwner(sql, actor);
  const [session] = await sql.query(
    "SELECT TOKEN_HASH FROM AUTH_SESSIONS WHERE TOKEN_HASH=? AND USER_ID=? AND WORKSPACE_ID=? AND EXPIRES_AT>?",
    [
      sessionHash,
      actor.userId,
      actor.workspaceId,
      sqlTimestamp(new Date().toISOString()),
    ],
  );
  if (!session)
    throw new DomainError(
      "OPENAI_OAUTH_SESSION_CHANGED",
      "Your Loom session expired or the active company changed. Return to Loom and start again.",
      401,
    );
}
function scopes(row: Row) {
  return String(row.SCOPES || "")
    .split(/\s+/)
    .filter(Boolean);
}
function model(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value.trim())
  )
    throw new DomainError(
      "INVALID_MODEL",
      "Enter a model ID available to your ChatGPT account (up to 200 characters).",
      422,
    );
  return value.trim();
}
function credentialAad(row: Row) {
  return JSON.stringify([
    "loom-openai-plan-v1",
    row.WORKSPACE_ID,
    row.USER_ID,
    row.HOST_ID,
    row.CLIENT_ID,
    row.SUBJECT,
  ]);
}
function tokensFrom(row: Row) {
  return tokenSchema.parse(
    JSON.parse(
      decryptProviderCredential(String(row.CREDENTIALS), credentialAad(row)),
    ),
  );
}
function encryptedTokens(row: Row, tokens: OpenAiTokens) {
  return encryptProviderCredential(JSON.stringify(tokens), credentialAad(row));
}
async function activeConnection(sql: SqlSession, actor: Actor) {
  const [row] = await sql.query(
    "SELECT * FROM OPENAI_CONNECTIONS WHERE WORKSPACE_ID=? AND USER_ID=? AND HOST_ID=? AND ACTIVE=TRUE",
    [actor.workspaceId, actor.userId, await openAiHostId()],
  );
  return row;
}
export async function readOpenAiPlanStatus(
  sql: SqlSession,
  actor: Actor,
): Promise<OpenAiPlanStatus | null> {
  let config;
  try {
    config = openAiOAuthConfig();
  } catch {
    return null;
  }
  if (!config || (await membership(sql, actor)).role !== "owner") return null;
  const row = await activeConnection(sql, actor);
  if (!row) return null;
  return {
    planEnabled: Boolean(row.CREDENTIALS) && hasOpenAiPlanScope(scopes(row)),
    model: row.MODEL ? String(row.MODEL) : null,
    clientId: String(row.CLIENT_ID),
    subject: String(row.SUBJECT),
    revision: Number(row.AUTH_VERSION),
  };
}
export async function assertOpenAiPlanCurrent(
  sql: SqlSession,
  actor: Actor,
  expected: { clientId: string; subject: string; revision?: number },
) {
  const current = await readOpenAiPlanStatus(sql, actor);
  if (
    !current?.planEnabled ||
    current.clientId !== expected.clientId ||
    current.subject !== expected.subject ||
    (expected.revision !== undefined && current.revision !== expected.revision)
  )
    throw new DomainError(
      "OPENAI_CONNECTION_CHANGED",
      "Your ChatGPT account, model, or permission changed. Send a new request.",
      409,
    );
}
// Called only after a definitive authentication rejection from the selected
// ChatGPT plan. A stale response cannot disconnect a newly selected account.
export async function invalidateOpenAiPlanCredential(
  actor: Actor,
  expected: { clientId: string; subject: string; revision: number },
) {
  requireOpenAiOAuthConfig();
  const hostId = await openAiHostId();
  await writeDatabase((sql) =>
    sql.execute(
      "UPDATE OPENAI_CONNECTIONS SET CREDENTIALS=NULL,AUTH_VERSION=AUTH_VERSION+1,REFRESH_OWNER=NULL,REFRESH_UNTIL=NULL WHERE WORKSPACE_ID=? AND USER_ID=? AND HOST_ID=? AND CLIENT_ID=? AND SUBJECT=? AND AUTH_VERSION=? AND ACTIVE=TRUE",
      [
        actor.workspaceId,
        actor.userId,
        hostId,
        expected.clientId,
        expected.subject,
        expected.revision,
      ],
    ),
  );
}
export async function readOpenAiConnection(
  actor: Actor,
): Promise<OpenAiConnectionStatus> {
  return readDatabase(async (sql) => {
    await assertOpenAiOwner(sql, actor);
    let config;
    try {
      config = openAiOAuthConfig();
    } catch {
      config = null;
    }
    const base = {
      configured: Boolean(config),
      canonicalOrigin: config?.origin ?? null,
      setupUrl: OPENAI_SETUP_URL,
    };
    if (!config)
      return {
        ...base,
        status: "not_configured",
        inferenceAvailable: false,
        clientId: null,
        identity: null,
        accounts: [],
        model: null,
        message:
          "Enable the local ChatGPT connection at Loom's 127.0.0.1 address. No commercial OpenAI client registration is required for this local open-source flow.",
      };
    const rows = await sql.query(
      "SELECT * FROM OPENAI_CONNECTIONS WHERE WORKSPACE_ID=? AND USER_ID=? AND HOST_ID=? ORDER BY VERIFIED_AT DESC",
      [actor.workspaceId, actor.userId, await openAiHostId()],
    );
    const row = rows.find((candidate) => candidate.ACTIVE === true);
    const permitted =
      Boolean(row?.CREDENTIALS) && hasOpenAiPlanScope(row ? scopes(row) : []);
    const state = !row
      ? "not_connected"
      : !row.CREDENTIALS
        ? "reconnect_required"
        : permitted
          ? "plan_enabled"
          : "identity_verified";
    return {
      ...base,
      status: state,
      inferenceAvailable: permitted,
      clientId: row ? String(row.CLIENT_ID) : null,
      model: row?.MODEL ? String(row.MODEL) : null,
      identity: row
        ? {
            email: row.EMAIL ? String(row.EMAIL) : null,
            name: row.DISPLAY_NAME ? String(row.DISPLAY_NAME) : null,
            verifiedAt: fromTimestamp(row.VERIFIED_AT),
          }
        : null,
      accounts: rows.map((entry) => ({
        clientId: String(entry.CLIENT_ID),
        email: entry.EMAIL ? String(entry.EMAIL) : null,
        name: entry.DISPLAY_NAME ? String(entry.DISPLAY_NAME) : null,
        active: entry.ACTIVE === true,
      })),
      message:
        state === "plan_enabled"
          ? "ChatGPT plan authorized for your own requests on this computer. Model availability is checked when you use it."
          : state === "identity_verified"
            ? "ChatGPT identity verified, but plan usage was not authorized. Continue with ChatGPT to grant plan access."
            : state === "reconnect_required"
              ? "Reconnect your ChatGPT account to renew access."
              : "Connect your ChatGPT account locally. Only your own Loom requests can use your plan.",
    };
  });
}
function transactionAad(row: Row) {
  return JSON.stringify([
    "loom-openai-oauth-v1",
    row.BROWSER_HASH,
    row.WORKSPACE_ID,
    row.USER_ID,
    row.SESSION_HASH,
  ]);
}
export async function startOpenAiConnection(
  actor: Actor,
  sessionToken: string | undefined,
  selection: { clientId?: string; newAccount?: boolean } = {},
) {
  const config = requireOpenAiOAuthConfig();
  if (!sessionToken || !isSessionToken(sessionToken))
    throw new DomainError(
      "UNAUTHENTICATED",
      "Sign in with a real Loom company account before connecting ChatGPT.",
      401,
    );
  const sessionHash = oauthDigest(sessionToken),
    hostId = await openAiHostId();
  const existing = await readDatabase(async (sql) => {
    await assertOpenAiOwnerSession(sql, actor, sessionHash);
    if (selection.newAccount) return undefined;
    const rows = await sql.query(
      "SELECT * FROM OPENAI_CONNECTIONS WHERE WORKSPACE_ID=? AND USER_ID=? AND HOST_ID=? ORDER BY ACTIVE DESC,VERIFIED_AT DESC",
      [actor.workspaceId, actor.userId, hostId],
    );
    const selected = selection.clientId
      ? rows.find((row) => row.CLIENT_ID === selection.clientId)
      : rows[0];
    if (selection.clientId && !selected)
      throw new DomainError(
        "OPENAI_ACCOUNT_NOT_FOUND",
        "Choose a ChatGPT registration belonging to your own account.",
        404,
      );
    return selected;
  });
  limitCredentialAttempt(`openai:${actor.workspaceId}:${actor.userId}`);
  const metadata = await discoverOpenAi(),
    transaction = createOpenAiTransaction(
      config,
      hostId,
      existing
        ? {
            clientId: String(existing.CLIENT_ID),
            subject:
              existing.SUBJECT && existing.SUBJECT !== "pending-unverified"
                ? String(existing.SUBJECT)
                : null,
          }
        : undefined,
    ),
    browserToken = randomBytes(32).toString("base64url");
  const record = {
    BROWSER_HASH: oauthDigest(browserToken),
    WORKSPACE_ID: actor.workspaceId,
    USER_ID: actor.userId,
    SESSION_HASH: sessionHash,
  };
  await writeDatabase(async (sql) => {
    await assertOpenAiOwnerSession(sql, actor, sessionHash);
    const expired = await sql.query(
      "SELECT BROWSER_HASH FROM OPENAI_OAUTH_TRANSACTIONS WHERE EXPIRES_AT<=? LIMIT 50",
      [sqlTimestamp(new Date().toISOString())],
    );
    for (const old of expired)
      await sql.execute(
        "DELETE FROM OPENAI_OAUTH_TRANSACTIONS WHERE BROWSER_HASH=?",
        [old.BROWSER_HASH],
      );
    await sql.execute(
      "DELETE FROM OPENAI_OAUTH_TRANSACTIONS WHERE WORKSPACE_ID=? AND USER_ID=?",
      [actor.workspaceId, actor.userId],
    );
    await sql.execute(
      "INSERT INTO OPENAI_OAUTH_TRANSACTIONS (BROWSER_HASH,WORKSPACE_ID,USER_ID,SESSION_HASH,PAYLOAD,EXPIRES_AT) VALUES (?,?,?,?,?,?)",
      [
        record.BROWSER_HASH,
        actor.workspaceId,
        actor.userId,
        sessionHash,
        encryptProviderCredential(
          JSON.stringify(transaction),
          transactionAad(record),
        ),
        sqlTimestamp(new Date(transaction.expiresAt).toISOString()),
      ],
    );
  });
  return {
    authorizationUrl: openAiAuthorizationUrl(metadata, transaction),
    browserToken,
    secure: false,
  };
}
export async function takeOpenAiTransaction(browserToken: string | undefined) {
  if (!browserToken || !isSessionToken(browserToken))
    throw new DomainError(
      "OPENAI_OAUTH_FAILED",
      "The sign-in attempt is missing or expired. Start again from Loom.",
      400,
    );
  const browserHash = oauthDigest(browserToken);
  const row = await writeDatabase(async (sql) => {
    const [record] = await sql.query(
      "SELECT * FROM OPENAI_OAUTH_TRANSACTIONS WHERE BROWSER_HASH=?",
      [browserHash],
    );
    if (!record?.PAYLOAD || record.PAYLOAD === "consumed") return null;
    return (await sql.execute(
      "UPDATE OPENAI_OAUTH_TRANSACTIONS SET PAYLOAD='consumed' WHERE BROWSER_HASH=? AND PAYLOAD=?",
      [browserHash, record.PAYLOAD],
    )) === 1
      ? record
      : null;
  });
  if (!row || Date.parse(fromTimestamp(row.EXPIRES_AT)) <= Date.now())
    throw new DomainError(
      "OPENAI_OAUTH_FAILED",
      "The sign-in attempt expired or was already used. Start again from Loom.",
      400,
    );
  const transaction = transactionSchema.parse(
    JSON.parse(
      decryptProviderCredential(String(row.PAYLOAD), transactionAad(row)),
    ),
  );
  if (transaction.hostId !== (await openAiHostId()))
    throw new DomainError(
      "OPENAI_HOST_CHANGED",
      "This sign-in belongs to a different computer. Start again.",
      409,
    );
  return {
    transaction,
    actor: {
      workspaceId: String(row.WORKSPACE_ID),
      userId: String(row.USER_ID),
    },
    sessionHash: String(row.SESSION_HASH),
    browserHash,
  };
}
export async function saveOpenAiIdentity(
  actor: Actor,
  sessionHash: string,
  identity: OpenAiIdentity,
  tokens: OpenAiTokens,
  browserHash: string,
) {
  await writeDatabase(async (sql) => {
    await assertOpenAiOwnerSession(sql, actor, sessionHash);
    requireOpenAiOAuthConfig();
    const [attempt] = await sql.query(
      "SELECT BROWSER_HASH FROM OPENAI_OAUTH_TRANSACTIONS WHERE BROWSER_HASH=? AND WORKSPACE_ID=? AND USER_ID=? AND PAYLOAD='consumed' AND EXPIRES_AT>?",
      [
        browserHash,
        actor.workspaceId,
        actor.userId,
        sqlTimestamp(new Date().toISOString()),
      ],
    );
    if (!attempt)
      throw new DomainError(
        "OPENAI_CONNECTION_CHANGED",
        "This connection attempt was cancelled or replaced. Start again from Loom.",
        409,
      );
    const hostId = await openAiHostId();
    const [existing] = await sql.query(
      "SELECT * FROM OPENAI_CONNECTIONS WHERE WORKSPACE_ID=? AND USER_ID=? AND HOST_ID=? AND CLIENT_ID=?",
      [actor.workspaceId, actor.userId, hostId, identity.clientId],
    );
    if (
      existing?.SUBJECT &&
      existing.SUBJECT !== "pending-unverified" &&
      existing.SUBJECT !== identity.subject
    )
      throw new DomainError(
        "OPENAI_IDENTITY_CONFLICT",
        "This ChatGPT registration belongs to a different identity. Start a new account connection.",
        409,
      );
    const record = {
      WORKSPACE_ID: actor.workspaceId,
      USER_ID: actor.userId,
      HOST_ID: hostId,
      CLIENT_ID: identity.clientId,
      SUBJECT: identity.subject,
    };
    const credential = encryptedTokens(record, tokens),
      verifiedAt = sqlTimestamp(new Date().toISOString());
    await sql.execute(
      "UPDATE OPENAI_CONNECTIONS SET ACTIVE=FALSE,AUTH_VERSION=AUTH_VERSION+1 WHERE WORKSPACE_ID=? AND USER_ID=? AND HOST_ID=? AND ACTIVE=?",
      [actor.workspaceId, actor.userId, hostId, true],
    );
    if (existing)
      await sql.execute(
        "UPDATE OPENAI_CONNECTIONS SET ISSUER=?,SUBJECT=?,EMAIL=?,DISPLAY_NAME=?,VERIFIED_AT=?,CREDENTIALS=?,SCOPES=?,ACTIVE=TRUE,AUTH_VERSION=AUTH_VERSION+1,REFRESH_OWNER=NULL,REFRESH_UNTIL=NULL WHERE WORKSPACE_ID=? AND USER_ID=? AND HOST_ID=? AND CLIENT_ID=?",
        [
          identity.issuer,
          identity.subject,
          identity.email,
          identity.name,
          verifiedAt,
          credential,
          tokens.scopes.join(" "),
          actor.workspaceId,
          actor.userId,
          hostId,
          identity.clientId,
        ],
      );
    else
      await sql.execute(
        "INSERT INTO OPENAI_CONNECTIONS (WORKSPACE_ID,USER_ID,HOST_ID,CLIENT_ID,ISSUER,SUBJECT,EMAIL,DISPLAY_NAME,VERIFIED_AT,CREDENTIALS,SCOPES,ACTIVE,AUTH_VERSION,MODEL) VALUES (?,?,?,?,?,?,?,?,?,?,?,TRUE,1,?)",
        [
          actor.workspaceId,
          actor.userId,
          hostId,
          identity.clientId,
          identity.issuer,
          identity.subject,
          identity.email,
          identity.name,
          verifiedAt,
          credential,
          tokens.scopes.join(" "),
          process.env.LOOM_CHATGPT_MODEL
            ? model(process.env.LOOM_CHATGPT_MODEL)
            : null,
        ],
      );
    await sql.execute(
      "DELETE FROM OPENAI_OAUTH_TRANSACTIONS WHERE BROWSER_HASH=?",
      [browserHash],
    );
  });
}
export async function completeOpenAiConnection(
  url: URL,
  browserToken: string | undefined,
) {
  const pending = await takeOpenAiTransaction(browserToken),
    config = requireOpenAiOAuthConfig();
  const { code, clientId } = validateOpenAiCallback(
    url,
    pending.transaction,
    config,
  );
  await readDatabase((sql) =>
    assertOpenAiOwnerSession(sql, pending.actor, pending.sessionHash),
  );
  // Registration has issued this client ID even if its one-use code later
  // expires. Keep an inactive mapping so a retry reuses the registration.
  if (pending.transaction.clientId === "dynamic_agent_client") {
    await writeDatabase(async (sql) => {
      await assertOpenAiOwnerSession(sql, pending.actor, pending.sessionHash);
      const [existing] = await sql.query(
        "SELECT CLIENT_ID FROM OPENAI_CONNECTIONS WHERE WORKSPACE_ID=? AND USER_ID=? AND HOST_ID=? AND CLIENT_ID=?",
        [
          pending.actor.workspaceId,
          pending.actor.userId,
          pending.transaction.hostId,
          clientId,
        ],
      );
      if (!existing)
        await sql.execute(
          "INSERT INTO OPENAI_CONNECTIONS (WORKSPACE_ID,USER_ID,HOST_ID,CLIENT_ID,ISSUER,SUBJECT,VERIFIED_AT,SCOPES,ACTIVE,AUTH_VERSION,MODEL) VALUES (?,?,?,?,?,'pending-unverified',?,'openid',FALSE,0,?)",
          [
            pending.actor.workspaceId,
            pending.actor.userId,
            pending.transaction.hostId,
            clientId,
            OPENAI_ISSUER,
            sqlTimestamp(new Date().toISOString()),
            process.env.LOOM_CHATGPT_MODEL
              ? model(process.env.LOOM_CHATGPT_MODEL)
              : null,
          ],
        );
    });
  }
  const result = await exchangeOpenAiCode(
    code,
    clientId,
    pending.transaction,
    await discoverOpenAi(),
  );
  await saveOpenAiIdentity(
    pending.actor,
    pending.sessionHash,
    result.identity,
    result.tokens,
    pending.browserHash,
  );
  return hasOpenAiPlanScope(result.tokens.scopes);
}
export async function updateOpenAiModel(actor: Actor, value: unknown) {
  const chosen = model(value);
  await writeDatabase(async (sql) => {
    const current = await readOpenAiPlanStatus(sql, actor);
    if (!current?.planEnabled)
      throw new DomainError(
        "OPENAI_PLAN_NOT_AUTHORIZED",
        "Authorize your ChatGPT plan before choosing its model.",
        409,
      );
    await sql.execute(
      "UPDATE OPENAI_CONNECTIONS SET MODEL=?,AUTH_VERSION=AUTH_VERSION+1 WHERE WORKSPACE_ID=? AND USER_ID=? AND HOST_ID=? AND CLIENT_ID=? AND ACTIVE=TRUE",
      [
        chosen,
        actor.workspaceId,
        actor.userId,
        await openAiHostId(),
        current.clientId,
      ],
    );
  });
  return readOpenAiConnection(actor);
}
// The database lease serializes refresh-token rotation across server instances.
// An uncertain exchange is never automatically replayed with an old token.
export async function getOpenAiPlanCredential(
  actor: Actor,
): Promise<OpenAiPlanCredential | null> {
  requireOpenAiOAuthConfig();
  const lease = randomUUID();
  let claimed: Row | null = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const result = await writeDatabase(async (sql) => {
      if ((await membership(sql, actor)).role !== "owner")
        return { kind: "absent" as const };
      const row = await activeConnection(sql, actor);
      if (!row || !row.CREDENTIALS || !hasOpenAiPlanScope(scopes(row)))
        return { kind: "absent" as const };
      const tokens = tokensFrom(row),
        now = Date.now();
      if (
        tokens.expiresAt > now + 60_000 ||
        (tokens.earliestRefreshAt > now && tokens.expiresAt > now + 5000)
      )
        return { kind: "ready" as const, row, tokens };
      if (tokens.earliestRefreshAt > now)
        throw new DomainError(
          "OPENAI_REFRESH_UNAVAILABLE",
          "ChatGPT renewal is not available yet. Try again shortly.",
          503,
        );
      if (
        row.REFRESH_OWNER &&
        Date.parse(fromTimestamp(row.REFRESH_UNTIL)) > now
      )
        return { kind: "busy" as const };
      const count = await sql.execute(
        "UPDATE OPENAI_CONNECTIONS SET REFRESH_OWNER=?,REFRESH_UNTIL=? WHERE WORKSPACE_ID=? AND USER_ID=? AND HOST_ID=? AND CLIENT_ID=? AND ACTIVE=TRUE AND AUTH_VERSION=?",
        [
          lease,
          sqlTimestamp(new Date(now + 35_000).toISOString()),
          actor.workspaceId,
          actor.userId,
          row.HOST_ID,
          row.CLIENT_ID,
          row.AUTH_VERSION,
        ],
      );
      return count === 1
        ? { kind: "claimed" as const, row }
        : { kind: "busy" as const };
    });
    if (result.kind === "absent") return null;
    if (result.kind === "ready")
      return credentialResult(result.row, result.tokens);
    if (result.kind === "claimed") {
      claimed = result.row;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!claimed)
    throw new DomainError(
      "OPENAI_REFRESH_UNAVAILABLE",
      "ChatGPT credentials are being renewed. Try again shortly.",
      503,
    );
  const row = claimed;
  try {
    const next = await refreshOpenAiTokens(
      String(row.CLIENT_ID),
      String(row.SUBJECT),
      tokensFrom(row),
      await discoverOpenAi(),
    );
    await writeDatabase(async (sql) => {
      await assertOpenAiOwner(sql, actor);
      const count = await sql.execute(
        "UPDATE OPENAI_CONNECTIONS SET CREDENTIALS=?,SCOPES=?,REFRESH_OWNER=NULL,REFRESH_UNTIL=NULL WHERE WORKSPACE_ID=? AND USER_ID=? AND HOST_ID=? AND CLIENT_ID=? AND ACTIVE=TRUE AND AUTH_VERSION=? AND REFRESH_OWNER=?",
        [
          encryptedTokens(row, next),
          next.scopes.join(" "),
          actor.workspaceId,
          actor.userId,
          row.HOST_ID,
          row.CLIENT_ID,
          row.AUTH_VERSION,
          lease,
        ],
      );
      if (count !== 1)
        throw new DomainError(
          "OPENAI_CONNECTION_CHANGED",
          "Your ChatGPT connection changed. Send a new request.",
          409,
        );
    });
    return hasOpenAiPlanScope(next.scopes) ? credentialResult(row, next) : null;
  } catch (error) {
    await writeDatabase(async (sql) => {
      const terminal =
        error instanceof DomainError &&
        error.code === "OPENAI_RECONNECT_REQUIRED";
      await sql.execute(
        terminal
          ? "UPDATE OPENAI_CONNECTIONS SET CREDENTIALS=NULL,AUTH_VERSION=AUTH_VERSION+1,REFRESH_OWNER=NULL,REFRESH_UNTIL=NULL WHERE WORKSPACE_ID=? AND USER_ID=? AND HOST_ID=? AND CLIENT_ID=? AND REFRESH_OWNER=?"
          : "UPDATE OPENAI_CONNECTIONS SET REFRESH_OWNER=NULL,REFRESH_UNTIL=NULL WHERE WORKSPACE_ID=? AND USER_ID=? AND HOST_ID=? AND CLIENT_ID=? AND REFRESH_OWNER=?",
        [actor.workspaceId, actor.userId, row.HOST_ID, row.CLIENT_ID, lease],
      );
    });
    throw error;
  }
}
function credentialResult(
  row: Row,
  tokens: OpenAiTokens,
): OpenAiPlanCredential {
  if (!tokens.accessToken)
    throw new DomainError(
      "OPENAI_RECONNECT_REQUIRED",
      "Reconnect your ChatGPT account to continue.",
      401,
    );
  return {
    planEnabled: true,
    model: row.MODEL ? String(row.MODEL) : null,
    clientId: String(row.CLIENT_ID),
    subject: String(row.SUBJECT),
    revision: Number(row.AUTH_VERSION),
    accessToken: tokens.accessToken,
    expiresAt: tokens.expiresAt,
  };
}
export async function disconnectOpenAiIdentity(actor: Actor) {
  requireOpenAiOAuthConfig();
  const row = await writeDatabase(async (sql) => {
    await assertOpenAiOwner(sql, actor);
    const current = await activeConnection(sql, actor);
    if (
      current?.REFRESH_OWNER &&
      Date.parse(fromTimestamp(current.REFRESH_UNTIL)) > Date.now()
    )
      throw new DomainError(
        "OPENAI_REFRESH_UNAVAILABLE",
        "ChatGPT credentials are being renewed. Try disconnecting again shortly.",
        409,
      );
    if (current)
      await sql.execute(
        "UPDATE OPENAI_CONNECTIONS SET ACTIVE=FALSE,AUTH_VERSION=AUTH_VERSION+1 WHERE WORKSPACE_ID=? AND USER_ID=? AND HOST_ID=? AND CLIENT_ID=?",
        [actor.workspaceId, actor.userId, current.HOST_ID, current.CLIENT_ID],
      );
    await sql.execute(
      "DELETE FROM OPENAI_OAUTH_TRANSACTIONS WHERE WORKSPACE_ID=? AND USER_ID=?",
      [actor.workspaceId, actor.userId],
    );
    return current;
  });
  let revocationConfirmed = true;
  if (row?.CREDENTIALS) {
    try {
      const tokens = tokensFrom(row);
      if (tokens.refreshToken)
        revocationConfirmed = await revokeOpenAiTokens(
          String(row.CLIENT_ID),
          tokens.refreshToken,
          await discoverOpenAi(),
        );
    } catch {
      revocationConfirmed = false;
    }
    await writeDatabase((sql) =>
      sql.execute(
        "UPDATE OPENAI_CONNECTIONS SET CREDENTIALS=NULL,REFRESH_OWNER=NULL,REFRESH_UNTIL=NULL WHERE WORKSPACE_ID=? AND USER_ID=? AND HOST_ID=? AND CLIENT_ID=? AND ACTIVE=FALSE AND AUTH_VERSION=?",
        [
          actor.workspaceId,
          actor.userId,
          row.HOST_ID,
          row.CLIENT_ID,
          Number(row.AUTH_VERSION) + 1,
        ],
      ),
    );
  }
  const status = await readOpenAiConnection(actor);
  return {
    ...status,
    revocationConfirmed,
    ...(!revocationConfirmed
      ? {
          message:
            "Disconnected locally. Remote revocation could not be confirmed; disconnect Loom in ChatGPT Settings as well.",
        }
      : {}),
  };
}
