import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { Actor } from "@loom/contracts";
import type { Row, SqlSession } from "@loom/db-exasol";
import { encryptProviderCredential } from "../apps/web/server/provider-config";
import {
  createOpenAiTransaction,
  oauthDigest,
  validateOpenAiCallback,
} from "../apps/web/server/openai-oauth";
import {
  invalidateOpenAiPlanCredential,
  assertOpenAiOwnerSession,
  assertOpenAiPlanCurrent,
  readOpenAiPlanStatus,
  saveOpenAiIdentity,
  takeOpenAiTransaction,
} from "../apps/web/server/openai-oauth-store";
const boundary = vi.hoisted(() => ({ sql: null as SqlSession | null }));
vi.mock("@loom/db-exasol", async (original) => ({
  ...(await original<typeof import("@loom/db-exasol")>()),
  readDatabase: (fn: (sql: SqlSession) => Promise<unknown>) =>
    fn(boundary.sql!),
  writeDatabase: (fn: (sql: SqlSession) => Promise<unknown>) =>
    fn(boundary.sql!),
}));
const hostId = "urn:uuid:11111111-1111-4111-8111-111111111111";
const config = {
  origin: "http://127.0.0.1:3000",
  redirectUri: "http://127.0.0.1:3000/api/oauth/openai/callback",
};
let actor: Actor,
  role: string,
  session: boolean,
  record: Row | null,
  connection: Row | null;
beforeEach(() => {
  actor = { userId: randomUUID(), workspaceId: randomUUID() };
  role = "owner";
  session = true;
  record = null;
  connection = null;
  vi.stubEnv("LOOM_OPENAI_LOCAL_ENABLED", "true");
  vi.stubEnv("APP_ORIGIN", config.origin);
  vi.stubEnv("LOOM_OPENAI_HOST_ID", hostId);
  vi.stubEnv("LOOM_PROVIDER_ENCRYPTION_KEY", "a".repeat(64));
  boundary.sql = {
    query: vi.fn(async (sql, values) => {
      if (sql.includes("FROM MEMBERSHIPS"))
        return [{ USER_ID: actor.userId, NAME: "Fixture", ROLE: role }];
      if (sql.includes("FROM AUTH_SESSIONS")) {
        expect(values?.slice(1, 3)).toEqual([actor.userId, actor.workspaceId]);
        expect(sql).toContain("EXPIRES_AT>?");
        return session ? [{ TOKEN_HASH: "fixture" }] : [];
      }
      if (sql.includes("FROM OPENAI_OAUTH_TRANSACTIONS"))
        return record && record.BROWSER_HASH === values?.[0]
          ? [{ ...record }]
          : [];
      if (sql.includes("FROM OPENAI_CONNECTIONS")) {
        expect(values?.slice(0, 3)).toEqual([
          actor.workspaceId,
          actor.userId,
          hostId,
        ]);
        return connection ? [{ ...connection }] : [];
      }
      throw new Error(`Unhandled test query: ${sql}`);
    }),
    execute: vi.fn(async (sql, values) => {
      if (
        sql.startsWith(
          "UPDATE OPENAI_OAUTH_TRANSACTIONS SET PAYLOAD='consumed'",
        ) &&
        record?.PAYLOAD &&
        record.PAYLOAD === values?.[1]
      ) {
        record.PAYLOAD = "consumed";
        return 1;
      }
      throw new Error(`Unexpected write: ${sql}`);
    }),
  };
});
afterEach(() => vi.unstubAllEnvs());
function pending(expired = false) {
  const browserToken = Buffer.alloc(32, 2).toString("base64url"),
    browserHash = oauthDigest(browserToken),
    sessionHash = oauthDigest("fixture-session");
  const transaction = createOpenAiTransaction(config, hostId);
  record = {
    BROWSER_HASH: browserHash,
    WORKSPACE_ID: actor.workspaceId,
    USER_ID: actor.userId,
    SESSION_HASH: sessionHash,
    PAYLOAD: encryptProviderCredential(
      JSON.stringify(transaction),
      JSON.stringify([
        "loom-openai-oauth-v1",
        browserHash,
        actor.workspaceId,
        actor.userId,
        sessionHash,
      ]),
    ),
    EXPIRES_AT: new Date(expired ? 1 : transaction.expiresAt).toISOString(),
  };
  return { browserToken, transaction, sessionHash };
}
it("consumes once before a state mismatch and rejects replay", async () => {
  const fixture = pending();
  const consumed = await takeOpenAiTransaction(fixture.browserToken);
  expect(record?.PAYLOAD).toBe("consumed");
  expect(() =>
    validateOpenAiCallback(
      new URL(
        `${config.redirectUri}?code=fake&client_id=oaiapp_fixture&state=wrong`,
      ),
      consumed.transaction,
      config,
    ),
  ).toThrow();
  await expect(
    takeOpenAiTransaction(fixture.browserToken),
  ).rejects.toMatchObject({ code: "OPENAI_OAUTH_FAILED" });
});
it("rejects an expired transaction after consuming its one-use secret", async () => {
  const fixture = pending(true);
  await expect(
    takeOpenAiTransaction(fixture.browserToken),
  ).rejects.toMatchObject({ code: "OPENAI_OAUTH_FAILED" });
  expect(record?.PAYLOAD).toBe("consumed");
});
it("only the current owner with the original unexpired session can finish", async () => {
  await expect(
    assertOpenAiOwnerSession(boundary.sql!, actor, "fixture-hash"),
  ).resolves.toBeUndefined();
  session = false;
  await expect(
    assertOpenAiOwnerSession(boundary.sql!, actor, "fixture-hash"),
  ).rejects.toMatchObject({ code: "OPENAI_OAUTH_SESSION_CHANGED" });
  session = true;
  role = "operator";
  await expect(
    assertOpenAiOwnerSession(boundary.sql!, actor, "fixture-hash"),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
});
it("will not save a token response after the owner cancels or replaces the consumed attempt", async () => {
  const fixture = pending();
  const consumed = await takeOpenAiTransaction(fixture.browserToken);
  record = null;
  await expect(
    saveOpenAiIdentity(
      actor,
      fixture.sessionHash,
      {
        issuer: "https://auth.openai.com",
        clientId: "oaiapp_fixture",
        subject: "fixture",
        email: null,
        name: null,
      },
      {
        idToken: "fixture",
        accessToken: "secret",
        refreshToken: "refresh",
        scopes: [],
        nonce: "fixture",
        expiresAt: 0,
        earliestRefreshAt: 0,
      },
      consumed.browserHash,
    ),
  ).rejects.toMatchObject({ code: "OPENAI_CONNECTION_CHANGED" });
});
it("never offers a different owner's plan and invalidates reservations on model/account changes", async () => {
  connection = {
    CLIENT_ID: "oaiapp_fixture",
    SUBJECT: "fixture",
    AUTH_VERSION: 7,
    MODEL: "chosen-model",
    CREDENTIALS: "encrypted",
    SCOPES: "offline_access resource.invoke chatgpt.tokens.use.direct",
  };
  expect(await readOpenAiPlanStatus(boundary.sql!, actor)).toEqual({
    planEnabled: true,
    model: "chosen-model",
    clientId: "oaiapp_fixture",
    subject: "fixture",
    revision: 7,
  });
  await expect(
    assertOpenAiPlanCurrent(boundary.sql!, actor, {
      clientId: "oaiapp_fixture",
      subject: "fixture",
      revision: 6,
    }),
  ).rejects.toMatchObject({ code: "OPENAI_CONNECTION_CHANGED" });
  role = "operator";
  expect(await readOpenAiPlanStatus(boundary.sql!, actor)).toBeNull();
  await expect(
    assertOpenAiPlanCurrent(boundary.sql!, actor, {
      clientId: "oaiapp_fixture",
      subject: "fixture",
      revision: 7,
    }),
  ).rejects.toMatchObject({ code: "OPENAI_CONNECTION_CHANGED" });
});
it("identity-only scopes do not authorize inference even with saved credential metadata", async () => {
  connection = {
    CLIENT_ID: "oaiapp_fixture",
    SUBJECT: "fixture",
    AUTH_VERSION: 1,
    MODEL: null,
    CREDENTIALS: "encrypted",
    SCOPES: "openid profile email",
  };
  expect((await readOpenAiPlanStatus(boundary.sql!, actor))?.planEnabled).toBe(
    false,
  );
});

it("invalidates only the rejected actor/client/subject/auth revision binding", async () => {
  const execute = vi.fn().mockResolvedValue(0);
  boundary.sql!.execute = execute;
  const expected = {
    clientId: "oaiapp_fixture",
    subject: "fixture",
    revision: 9,
  };
  await invalidateOpenAiPlanCredential(actor, expected);
  expect(execute).toHaveBeenCalledWith(
    expect.stringContaining(
      "CLIENT_ID=? AND SUBJECT=? AND AUTH_VERSION=? AND ACTIVE=TRUE",
    ),
    [
      actor.workspaceId,
      actor.userId,
      hostId,
      expected.clientId,
      expected.subject,
      expected.revision,
    ],
  );
  expect(execute.mock.calls[0][0]).toContain(
    "CREDENTIALS=NULL,AUTH_VERSION=AUTH_VERSION+1",
  );
});
