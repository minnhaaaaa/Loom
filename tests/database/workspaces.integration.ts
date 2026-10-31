import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { isConfigured, readDatabase, writeDatabase } from "@loom/db-exasol";
import { type RegistrationInput, type SessionGrant } from "@loom/contracts";
import {
  registerAccount,
  loginAccount,
  accountContext,
  sessionActor,
  selectSessionWorkspace,
  revokeSession,
} from "../../apps/web/server/accounts";
import {
  createWorkspace,
  createInvitation,
  invitationPreview,
  acceptInvitation,
  workspaceAccess,
  changeMembership,
  revokeInvitation,
} from "../../apps/web/server/workspaces";
import { hashToken } from "../../apps/web/server/identity-crypto";
import { createRequest, details, snapshot } from "../../apps/web/server/desk";

if (!isConfigured())
  throw new Error(
    "Real Exasol is required for workspace-access integration. Apply migration 006 first.",
  );
const workspaces = new Set<string>(),
  users = new Set<string>();
const password = "Synthetic workspace password 2026!";
beforeAll(() => {
  vi.stubEnv("LOOM_ALLOW_WORKSPACE_SIGNUP", "true");
  vi.stubEnv("LOOM_AUTH_MODE", "workspace");
  vi.stubEnv(
    "LOOM_SESSION_SECRET",
    "public-workspace-integration-secret-at-least-32-characters",
  );
});
function credentials(name: string) {
  return { name, email: `fixture-${randomUUID()}@example.test`, password };
}
async function register(
  name: string,
): Promise<{ grant: SessionGrant; input: RegistrationInput }> {
  const input = {
      ...credentials(name),
      workspaceName: `${name} fixture workspace`,
    },
    grant = await registerAccount(input);
  workspaces.add(grant.actor.workspaceId);
  users.add(grant.actor.userId);
  return { input, grant };
}
afterAll(async () => {
  await writeDatabase(async (sql) => {
    for (const userId of users)
      await sql.execute("DELETE FROM AUTH_SESSIONS WHERE USER_ID=?", [userId]);
    for (const table of [
      "WORKSPACE_INVITATIONS",
      "WORKSPACE_EVENTS",
      "COMMENTS",
      "REQUEST_EVENTS",
      "AUDIT_EVENTS",
      "OUTBOX_EVENTS",
      "COMMAND_RECEIPTS",
      "REQUESTS",
      "MEMBERSHIPS",
      "WORKSPACES",
    ])
      for (const id of workspaces)
        await sql.execute(
          `DELETE FROM ${table} WHERE ${table === "WORKSPACES" ? "ID" : "WORKSPACE_ID"}=?`,
          [id],
        );
    for (const userId of users) {
      await sql.execute("DELETE FROM ACCOUNT_COMMANDS WHERE USER_ID=?", [
        userId,
      ]);
      await sql.execute("DELETE FROM AUTH_IDENTITIES WHERE USER_ID=?", [
        userId,
      ]);
      await sql.execute("DELETE FROM AUTH_USERS WHERE ID=?", [userId]);
    }
  });
  vi.unstubAllEnvs();
});
it("registers normalized identities, persists only hashed sessions, and switches only into authorized workspaces", async () => {
  const first = await register("Owner one"),
    other = await register("Owner two");
  const loggedIn = await loginAccount({
    email: ` ${first.input.email.toUpperCase()} `,
    password,
  });
  expect(loggedIn.actor.userId).toBe(first.grant.actor.userId);
  await expect(
    loginAccount({
      email: first.input.email,
      password: "incorrect fixture password",
    }),
  ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  await expect(
    registerAccount({ ...first.input, email: first.input.email.toUpperCase() }),
  ).rejects.toMatchObject({ code: "ACCOUNT_EXISTS" });
  const commandId = randomUUID(),
    created = await createWorkspace(
      loggedIn.actor,
      commandId,
      "Second authorized workspace",
    );
  workspaces.add(created.id);
  expect(
    await createWorkspace(
      loggedIn.actor,
      commandId,
      "Second authorized workspace",
    ),
  ).toEqual(created);
  await expect(
    selectSessionWorkspace(loggedIn.token, other.grant.actor.workspaceId),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  const selected = await selectSessionWorkspace(loggedIn.token, created.id);
  expect(await sessionActor(loggedIn.token)).toEqual(selected);
  expect((await accountContext(selected)).workspaces).toHaveLength(2);
  const [stored] = await readDatabase((sql) =>
    sql.query("SELECT TOKEN_HASH FROM AUTH_SESSIONS WHERE TOKEN_HASH=?", [
      hashToken(loggedIn.token),
    ]),
  );
  expect(stored.TOKEN_HASH).toBe(hashToken(loggedIn.token));
  expect(stored.TOKEN_HASH).not.toBe(loggedIn.token);
  const record = await createRequest(selected, randomUUID(), {
    title: "Isolated workspace request",
    businessQuestion: "A synthetic isolation check",
    reportingPeriod: "",
    dataset: "",
  });
  await expect(details(other.grant.actor, record.id)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await revokeSession(loggedIn.token);
  expect(await sessionActor(loggedIn.token)).toBeNull();
});
it("accepts one-use role-bound invitations, blocks identity takeover, and protects owner administration", async () => {
  const owner = await register("Invitation owner"),
    existing = await register("Existing account");
  const commandId = randomUUID(),
    invitation = await createInvitation(
      owner.grant.actor,
      commandId,
      "operator",
    );
  expect(
    (await createInvitation(owner.grant.actor, commandId, "operator")).token,
  ).toBe(invitation.token);
  expect(await invitationPreview(invitation.token)).toEqual({
    workspace: {
      id: owner.grant.actor.workspaceId,
      name: owner.input.workspaceName,
    },
    role: "operator",
    expiresAt: invitation.expiresAt,
  });
  const newcomer = credentials("Invited operator"),
    joined = await acceptInvitation(invitation.token, newcomer);
  users.add(joined.actor.userId);
  expect((await workspaceAccess(joined.actor)).membership.role).toBe(
    "operator",
  );
  expect((await workspaceAccess(joined.actor)).members).toEqual([]);
  await expect(
    createInvitation(joined.actor, randomUUID(), "viewer"),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  await expect(
    acceptInvitation(invitation.token, joined.actor.userId),
  ).rejects.toMatchObject({ code: "INVITATION_UNAVAILABLE" });
  const takeover = await createInvitation(
    owner.grant.actor,
    randomUUID(),
    "requester",
  );
  await expect(
    acceptInvitation(takeover.token, {
      name: "Claim existing identity",
      email: existing.input.email,
      password,
    }),
  ).rejects.toMatchObject({ code: "ACCOUNT_EXISTS" });
  await acceptInvitation(takeover.token, existing.grant.actor.userId);
  const before = await workspaceAccess(owner.grant.actor),
    member = before.members.find(
      (item) => item.userId === joined.actor.userId,
    )!;
  expect(before.invitations.every((item) => !("token" in item))).toBe(true);
  await expect(
    changeMembership(
      owner.grant.actor,
      owner.grant.actor.userId,
      randomUUID(),
      1,
      "operator",
      true,
    ),
  ).rejects.toMatchObject({ code: "LAST_OWNER" });
  const changed = await changeMembership(
    owner.grant.actor,
    member.userId,
    randomUUID(),
    member.version,
    "viewer",
    true,
  );
  await expect(
    changeMembership(
      owner.grant.actor,
      member.userId,
      randomUUID(),
      member.version,
      "requester",
      true,
    ),
  ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  const pending = await createInvitation(
    owner.grant.actor,
    randomUUID(),
    "viewer",
  );
  const promoted = await changeMembership(
    owner.grant.actor,
    member.userId,
    randomUUID(),
    changed.version,
    "owner",
    true,
  );
  expect(promoted.role).toBe("owner");
  await changeMembership(
    owner.grant.actor,
    owner.grant.actor.userId,
    randomUUID(),
    1,
    "operator",
    true,
  );
  await expect(invitationPreview(pending.token)).rejects.toMatchObject({
    code: "INVITATION_UNAVAILABLE",
  });
  const revoked = await revokeInvitation(
    joined.actor,
    pending.id,
    randomUUID(),
    pending.version,
  );
  expect(revoked.state).toBe("revoked");
});
it("lets a revoked invitation-only account authenticate and accept fresh access without exposing the revoked workspace", async () => {
  const owner = await register("Revocation owner"),
    newcomer = credentials("Invitation-only account");
  const invitation = await createInvitation(
      owner.grant.actor,
      randomUUID(),
      "viewer",
    ),
    joined = await acceptInvitation(invitation.token, newcomer);
  users.add(joined.actor.userId);
  await changeMembership(
    owner.grant.actor,
    joined.actor.userId,
    randomUUID(),
    1,
    "viewer",
    false,
  );
  const authenticated = await loginAccount({ email: newcomer.email, password });
  expect(await sessionActor(authenticated.token)).toEqual(authenticated.actor);
  const context = await accountContext(authenticated.actor);
  expect(context.user?.id).toBe(joined.actor.userId);
  expect(context.currentWorkspaceId).toBeNull();
  expect(context.workspaces).toEqual([]);
  await expect(snapshot(authenticated.actor)).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  const commandId = randomUUID(),
    personal = await createWorkspace(
      authenticated.actor,
      commandId,
      "Recovered account workspace",
    );
  workspaces.add(personal.id);
  const personalActor = await selectSessionWorkspace(
    authenticated.token,
    personal.id,
  );
  expect((await workspaceAccess(personalActor)).membership.role).toBe("owner");
  expect(
    await createWorkspace(
      personalActor,
      commandId,
      "Recovered account workspace",
    ),
  ).toEqual(personal);
  await expect(snapshot(authenticated.actor)).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  const fresh = await createInvitation(
      owner.grant.actor,
      randomUUID(),
      "requester",
    ),
    accepted = await acceptInvitation(fresh.token, authenticated.actor.userId);
  expect((await workspaceAccess(accepted.actor)).membership).toMatchObject({
    role: "requester",
    active: true,
    version: 3,
  });
});
