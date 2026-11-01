import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Actor } from "@loom/contracts";
import { DomainError } from "@loom/domain";
import {
  fromTimestamp,
  readDatabase,
  writeDatabase,
  sqlTimestamp,
  type SqlSession,
  type Row,
} from "@loom/db-exasol";
import { membership } from "./desk";
import {
  encryptProviderCredential,
  decryptProviderCredential,
} from "./provider-config";
import {
  graph,
  microsoftConfiguration,
  microsoftForm,
  microsoftScopes,
  slack,
  string,
  SourceError,
} from "./source-transport";
import { limitCredentialAttempt } from "./auth-limits";

import { discord, discordApplication, discordId } from "./discord-source";
import { object } from "./source-transport";
import { github } from "./github-source";
export type ConnectionKind = "slack" | "microsoft" | "discord" | "github";
const credentialSchema = z.object({
  accessToken: z.string().min(10).max(16000),
  refreshToken: z.string().max(16000).optional(),
  expiresAt: z.number().optional(),
});
type Credential = z.infer<typeof credentialSchema>;
export async function sourceOwner(sql: SqlSession, actor: Actor) {
  const member = await membership(sql, actor);
  if (member.role !== "owner")
    throw new DomainError(
      "ACCESS_DENIED",
      "Only company owners can connect sources.",
      403,
    );
  return member;
}
export async function connectionRow(
  sql: SqlSession,
  actor: Actor,
  provider: ConnectionKind,
) {
  const [row] = await sql.query(
    "SELECT * FROM SOURCE_CONNECTIONS WHERE WORKSPACE_ID=? AND PROVIDER=?",
    [actor.workspaceId, provider],
  );
  return row;
}
function associated(row: Row) {
  return JSON.stringify({
    purpose: "source-connection",
    workspaceId: row.WORKSPACE_ID,
    provider: row.PROVIDER,
    version: Number(row.VERSION),
    ownerId: row.OWNER_ID,
  });
}
function encode(row: Row, value: Credential) {
  return encryptProviderCredential(JSON.stringify(value), associated(row));
}
function decode(row: Row) {
  return credentialSchema.parse(
    JSON.parse(
      decryptProviderCredential(String(row.CREDENTIAL), associated(row)),
    ),
  );
}
export async function saveSourceConnection(
  sql: SqlSession,
  actor: Actor,
  provider: ConnectionKind,
  accountId: string,
  name: string,
  credential: Credential,
) {
  await sourceOwner(sql, actor);
  const old = await connectionRow(sql, actor, provider);
  const row: Row = {
    WORKSPACE_ID: actor.workspaceId,
    PROVIDER: provider,
    VERSION: Number(old?.VERSION || 0) + 1,
    OWNER_ID: actor.userId,
  };
  const encrypted = encode(row, credential);
  if (old)
    await sql.execute(
      "UPDATE SOURCE_CONNECTIONS SET VERSION=?,OWNER_ID=?,ACCOUNT_ID=?,DISPLAY_NAME=?,CREDENTIAL=?,ACTIVE=TRUE WHERE WORKSPACE_ID=? AND PROVIDER=?",
      [
        row.VERSION,
        actor.userId,
        accountId,
        name.slice(0, 160),
        encrypted,
        actor.workspaceId,
        provider,
      ],
    );
  else
    await sql.execute(
      "INSERT INTO SOURCE_CONNECTIONS (WORKSPACE_ID,PROVIDER,VERSION,OWNER_ID,ACCOUNT_ID,DISPLAY_NAME,CREDENTIAL,ACTIVE) VALUES (?,?,?,?,?,?,?,TRUE)",
      [
        actor.workspaceId,
        provider,
        row.VERSION,
        actor.userId,
        accountId,
        name.slice(0, 160),
        encrypted,
      ],
    );
  // A reconnect may be a different account. Explicitly reselect sources before reading it.
  await sql.execute(
    "UPDATE CONNECTED_SOURCES SET ACTIVE=FALSE,VERSION=VERSION+1,LEASE_ID=NULL,LEASE_UNTIL=NULL WHERE WORKSPACE_ID=? AND PROVIDER IN (?,?)",
    [
      actor.workspaceId,
      provider === "microsoft" ? "teams" : provider,
      provider === "microsoft" ? "sharepoint" : provider,
    ],
  );
}
export async function connectGithub(actor: Actor, token: string) {
  await readDatabase((sql) => sourceOwner(sql, actor));
  limitCredentialAttempt(`source-github:${actor.workspaceId}:${actor.userId}`);
  const value = z
    .string()
    .trim()
    .regex(/^github_pat_[A-Za-z0-9_]+$/)
    .max(2000)
    .parse(token);
  const user = object(await github(value, "user"));
  if (!Number.isSafeInteger(user.id) || !string(user.login))
    throw new SourceError("GitHub did not identify this account.");
  await writeDatabase((sql) =>
    saveSourceConnection(
      sql,
      actor,
      "github",
      String(user.id),
      string(user.login),
      { accessToken: value },
    ),
  );
}
export async function connectSlack(actor: Actor, token: string) {
  await readDatabase((sql) => sourceOwner(sql, actor));
  limitCredentialAttempt(`source-slack:${actor.workspaceId}:${actor.userId}`);
  const value = z
    .string()
    .trim()
    .regex(/^xox[bp]-[A-Za-z0-9-]+$/)
    .max(2000)
    .parse(token);
  const account = await slack(value, "auth.test");
  if (!string(account.team_id))
    throw new SourceError("Slack did not identify this workspace.");
  await writeDatabase((sql) =>
    saveSourceConnection(
      sql,
      actor,
      "slack",
      string(account.team_id),
      string(account.team) || "Slack",
      { accessToken: value },
    ),
  );
}
export async function connectDiscord(actor: Actor, token: string) {
  await readDatabase((sql) => sourceOwner(sql, actor));
  limitCredentialAttempt(`source-discord:${actor.workspaceId}:${actor.userId}`);
  const value = z
    .string()
    .trim()
    .min(20)
    .max(2000)
    .regex(/^[A-Za-z0-9._-]+$/)
    .parse(token);
  const me = object(await discord(value, "users/@me"));
  if (me.bot !== true)
    throw new SourceError(
      "Use a Discord bot token from the Developer Portal, not a personal account token.",
      900,
      "SOURCE_ACCESS",
    );
  const app = await discordApplication(value);
  await writeDatabase((sql) =>
    saveSourceConnection(
      sql,
      actor,
      "discord",
      discordId(string(me.id)),
      string(app.name) || string(me.username) || "Discord",
      { accessToken: value },
    ),
  );
}
export async function disconnectSourceConnection(
  actor: Actor,
  provider: ConnectionKind,
) {
  await writeDatabase(async (sql) => {
    await sourceOwner(sql, actor);
    await sql.execute(
      "UPDATE SOURCE_CONNECTIONS SET ACTIVE=FALSE,CREDENTIAL=NULL,VERSION=VERSION+1 WHERE WORKSPACE_ID=? AND PROVIDER=?",
      [actor.workspaceId, provider],
    );
    await sql.execute(
      "UPDATE CONNECTED_SOURCES SET ACTIVE=FALSE,VERSION=VERSION+1,LEASE_ID=NULL,LEASE_UNTIL=NULL WHERE WORKSPACE_ID=? AND PROVIDER IN (?,?)",
      [
        actor.workspaceId,
        provider === "microsoft" ? "teams" : provider,
        provider === "microsoft" ? "sharepoint" : provider,
      ],
    );
    if (provider === "microsoft")
      await sql.execute("DELETE FROM SOURCE_SIGNINS WHERE WORKSPACE_ID=?", [
        actor.workspaceId,
      ]);
  });
}
const refreshing = new Map<string, Promise<void>>();
export async function sourceRuntime(actor: Actor, provider: ConnectionKind) {
  let row = await readDatabase(async (sql) => {
    await sourceOwner(sql, actor);
    const saved = await connectionRow(sql, actor, provider);
    if (!saved?.ACTIVE || !saved.CREDENTIAL)
      throw new DomainError(
        "SOURCE_DISCONNECTED",
        "Connect this service first.",
        409,
      );
    await sourceOwner(sql, { ...actor, userId: String(saved.OWNER_ID) });
    return saved;
  });
  let credential = decode(row);
  if (
    provider === "microsoft" &&
    (credential.expiresAt || 0) < Date.now() + 60_000
  ) {
    const key = `${actor.workspaceId}:${row.VERSION}`;
    let pending = refreshing.get(key);
    if (!pending) {
      const original = row;
      pending = (async () => {
        if (!credential.refreshToken)
          throw new SourceError(
            "Reconnect Microsoft to renew access.",
            900,
            "SOURCE_ACCESS",
          );
        const reply = await microsoftForm("token", {
          grant_type: "refresh_token",
          refresh_token: credential.refreshToken,
          scope: microsoftScopes,
        });
        if (!reply.access_token)
          throw new SourceError(
            "Microsoft access expired. Connect Microsoft again.",
            900,
            "SOURCE_ACCESS",
          );
        const fresh = credentialSchema.parse({
          accessToken: reply.access_token,
          refreshToken: reply.refresh_token || credential.refreshToken,
          expiresAt:
            Date.now() +
            Math.max(60, Math.min(86400, Number(reply.expires_in) || 3600)) *
              1000,
        });
        await writeDatabase(async (sql) => {
          await sourceOwner(sql, actor);
          await sourceOwner(sql, {
            ...actor,
            userId: String(original.OWNER_ID),
          });
          const changed = await sql.execute(
            "UPDATE SOURCE_CONNECTIONS SET CREDENTIAL=? WHERE WORKSPACE_ID=? AND PROVIDER='microsoft' AND VERSION=? AND ACTIVE=TRUE AND CREDENTIAL=?",
            [
              encode(original, fresh),
              actor.workspaceId,
              original.VERSION,
              original.CREDENTIAL,
            ],
          );
          if (changed !== 1)
            throw new DomainError(
              "SOURCE_CHANGED",
              "The source connection changed. Try again.",
              409,
            );
        });
      })().finally(() => refreshing.delete(key));
      refreshing.set(key, pending);
    }
    await pending;
    row = await readDatabase(async (sql) => {
      await sourceOwner(sql, actor);
      const current = await connectionRow(sql, actor, provider);
      if (!current?.ACTIVE || Number(current.VERSION) !== Number(row.VERSION))
        throw new DomainError(
          "SOURCE_CHANGED",
          "The source connection changed. Try again.",
          409,
        );
      return current;
    });
    credential = decode(row);
  }
  return {
    token: credential.accessToken,
    version: Number(row.VERSION),
    ownerId: String(row.OWNER_ID),
    accountId: String(row.ACCOUNT_ID),
  };
}
function signinAssociated(actor: Actor, id: string) {
  return JSON.stringify({ purpose: "microsoft-device", ...actor, id });
}
export async function startMicrosoftSignin(actor: Actor) {
  await readDatabase((sql) => sourceOwner(sql, actor));
  limitCredentialAttempt(
    `source-microsoft:${actor.workspaceId}:${actor.userId}`,
  );
  const reply = await microsoftForm("devicecode", { scope: microsoftScopes });
  const code = z.string().min(1).max(8000).parse(reply.device_code);
  const userCode = z.string().min(1).max(40).parse(reply.user_code);
  const verification = new URL(string(reply.verification_uri));
  if (
    verification.protocol !== "https:" ||
    ![
      "microsoft.com",
      "www.microsoft.com",
      "login.microsoftonline.com",
    ].includes(verification.hostname)
  )
    throw new SourceError("Microsoft returned an invalid sign-in address.");
  const id = randomUUID(),
    seconds = Math.max(5, Math.min(30, Number(reply.interval) || 5));
  const expiresAt = new Date(
    Date.now() +
      Math.max(60, Math.min(900, Number(reply.expires_in) || 900)) * 1000,
  ).toISOString();
  const encrypted = encryptProviderCredential(
    code,
    signinAssociated(actor, id),
  );
  await writeDatabase(async (sql) => {
    await sourceOwner(sql, actor);
    await sql.execute(
      "DELETE FROM SOURCE_SIGNINS WHERE WORKSPACE_ID=? AND OWNER_ID=?",
      [actor.workspaceId, actor.userId],
    );
    await sql.execute(
      "INSERT INTO SOURCE_SIGNINS (WORKSPACE_ID,OWNER_ID,ID,CREDENTIAL,EXPIRES_AT,NEXT_POLL_AT,POLL_SECONDS) VALUES (?,?,?,?,?,?,?)",
      [
        actor.workspaceId,
        actor.userId,
        id,
        encrypted,
        sqlTimestamp(expiresAt),
        sqlTimestamp(new Date(Date.now() + seconds * 1000).toISOString()),
        seconds,
      ],
    );
  });
  return {
    id,
    userCode,
    verificationUri: verification.href,
    expiresAt,
    interval: seconds,
  };
}
export async function pollMicrosoftSignin(actor: Actor, id: string) {
  const pending = await writeDatabase(async (sql) => {
    await sourceOwner(sql, actor);
    const [row] = await sql.query(
      "SELECT * FROM SOURCE_SIGNINS WHERE WORKSPACE_ID=? AND OWNER_ID=? AND ID=?",
      [actor.workspaceId, actor.userId, id],
    );
    if (!row || fromTimestamp(row.EXPIRES_AT) <= new Date().toISOString())
      throw new DomainError(
        "SIGNIN_EXPIRED",
        "Microsoft sign-in expired. Connect again.",
        410,
      );
    if (fromTimestamp(row.NEXT_POLL_AT) > new Date().toISOString()) return null;
    await sql.execute(
      "UPDATE SOURCE_SIGNINS SET NEXT_POLL_AT=? WHERE WORKSPACE_ID=? AND OWNER_ID=? AND ID=?",
      [
        sqlTimestamp(
          new Date(Date.now() + Number(row.POLL_SECONDS) * 1000).toISOString(),
        ),
        actor.workspaceId,
        actor.userId,
        id,
      ],
    );
    return row;
  });
  if (!pending) return { connected: false };
  const reply = await microsoftForm("token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: decryptProviderCredential(
      String(pending.CREDENTIAL),
      signinAssociated(actor, id),
    ),
  });
  if (reply.error === "authorization_pending") return { connected: false };
  if (reply.error === "slow_down") {
    await writeDatabase(async (sql) => {
      await sourceOwner(sql, actor);
      await sql.execute(
        "UPDATE SOURCE_SIGNINS SET POLL_SECONDS=POLL_SECONDS+5,NEXT_POLL_AT=? WHERE WORKSPACE_ID=? AND OWNER_ID=? AND ID=?",
        [
          sqlTimestamp(
            new Date(
              Date.now() + (Number(pending.POLL_SECONDS) + 5) * 1000,
            ).toISOString(),
          ),
          actor.workspaceId,
          actor.userId,
          id,
        ],
      );
    });
    return { connected: false };
  }
  if (!reply.access_token) {
    await writeDatabase((sql) =>
      sql.execute(
        "DELETE FROM SOURCE_SIGNINS WHERE WORKSPACE_ID=? AND OWNER_ID=? AND ID=?",
        [actor.workspaceId, actor.userId, id],
      ),
    );
    throw new SourceError(
      "Microsoft sign-in was declined or expired. Check app permissions and connect again.",
    );
  }
  const credential = credentialSchema.parse({
    accessToken: reply.access_token,
    refreshToken: reply.refresh_token,
    expiresAt:
      Date.now() +
      Math.max(60, Math.min(86400, Number(reply.expires_in) || 3600)) * 1000,
  });
  const me = await graph(credential.accessToken, "me?$select=id,displayName");
  if (!string(me.id))
    throw new SourceError("Microsoft did not identify this account.");
  await writeDatabase(async (sql) => {
    await sourceOwner(sql, actor);
    const [current] = await sql.query(
      "SELECT ID FROM SOURCE_SIGNINS WHERE WORKSPACE_ID=? AND OWNER_ID=? AND ID=? AND EXPIRES_AT>?",
      [
        actor.workspaceId,
        actor.userId,
        id,
        sqlTimestamp(new Date().toISOString()),
      ],
    );
    if (!current)
      throw new DomainError(
        "SIGNIN_EXPIRED",
        "This sign-in was replaced. Connect again.",
        409,
      );
    await saveSourceConnection(
      sql,
      actor,
      "microsoft",
      `${microsoftConfiguration().tenantId}:${string(me.id)}`,
      string(me.displayName) || "Microsoft 365",
      credential,
    );
    await sql.execute(
      "DELETE FROM SOURCE_SIGNINS WHERE WORKSPACE_ID=? AND OWNER_ID=? AND ID=?",
      [actor.workspaceId, actor.userId, id],
    );
  });
  return { connected: true };
}
