import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  defaultWorkspaceSettings,
  type Actor,
  type UpdateWorkspaceSettings,
} from "@loom/contracts";
import { isConfigured, readDatabase, writeDatabase } from "@loom/db-exasol";
import {
  authenticateAgentToken,
  createAgentConnection,
  listAgentConnections,
  readWorkspaceSettings,
  revokeAgentConnection,
  touchAgentConnection,
  updateWorkspaceSettings,
} from "../../apps/web/server/settings";
import { hashToken } from "../../apps/web/server/identity-crypto";

if (!isConfigured())
  throw new Error(
    "Real Exasol is required. Apply migration007 before running company-settings integration.",
  );
const workspaceId = randomUUID(),
  foreignWorkspaceId = randomUUID();
const owner: Actor = { workspaceId, userId: randomUUID() },
  requester: Actor = { workspaceId, userId: randomUUID() };
const foreignOwner: Actor = {
  workspaceId: foreignWorkspaceId,
  userId: randomUUID(),
};
beforeAll(async () => {
  await writeDatabase(async (sql) => {
    for (const id of [workspaceId, foreignWorkspaceId])
      await sql.execute("INSERT INTO WORKSPACES (ID,NAME) VALUES (?,?)", [
        id,
        "Company setup integration fixture",
      ]);
    for (const [actor, role] of [
      [owner, "owner"],
      [requester, "requester"],
      [foreignOwner, "owner"],
    ] as const)
      await sql.execute(
        "INSERT INTO MEMBERSHIPS (WORKSPACE_ID,USER_ID,NAME,ROLE,ACTIVE,VERSION) VALUES (?,?,?,?,TRUE,1)",
        [actor.workspaceId, actor.userId, "Setup fixture", role],
      );
  });
});
afterAll(async () => {
  await writeDatabase(async (sql) => {
    for (const table of [
      "AGENT_CONNECTIONS",
      "WORKSPACE_SETTINGS",
      "WORKSPACE_EVENTS",
      "COMMAND_RECEIPTS",
      "MEMBERSHIPS",
      "WORKSPACES",
    ])
      for (const id of [workspaceId, foreignWorkspaceId])
        await sql.execute(
          `DELETE FROM ${table} WHERE ${table === "WORKSPACES" ? "ID" : "WORKSPACE_ID"}=?`,
          [id],
        );
  });
});
function input(expectedVersion: number): UpdateWorkspaceSettings {
  return {
    commandId: randomUUID(),
    expectedVersion,
    branding: {
      ...defaultWorkspaceSettings.branding,
      companyName: "Orbit Research",
      primaryColor: "#2244aa",
      accentColor: "#ffcc55",
      font: "technical",
      corners: "square",
    },
    preferredAgent: "codex",
    completeSetup: true,
  };
}

it("persists company presentation once, shares it only inside the workspace, and rejects stale/nonowner saves", async () => {
  expect(await readWorkspaceSettings(owner)).toEqual(defaultWorkspaceSettings);
  const values = input(0),
    saved = await updateWorkspaceSettings(owner, values);
  expect(saved.version).toBe(1);
  expect(saved.setupCompletedAt).toBeTruthy();
  expect((await readWorkspaceSettings(requester)).branding).toEqual(
    values.branding,
  );
  expect(await updateWorkspaceSettings(owner, values)).toEqual(saved);
  await expect(updateWorkspaceSettings(owner, input(0))).rejects.toMatchObject({
    code: "SETTINGS_VERSION_CONFLICT",
  });
  await expect(
    updateWorkspaceSettings(requester, input(1)),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  await expect(
    readWorkspaceSettings({ ...owner, workspaceId: foreignWorkspaceId }),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  expect(await readWorkspaceSettings(foreignOwner)).toEqual(
    defaultWorkspaceSettings,
  );
  const next = await updateWorkspaceSettings(owner, {
    ...input(1),
    completeSetup: false,
  });
  expect(next.version).toBe(2);
  expect(next.setupCompletedAt).toBe(saved.setupCompletedAt);
  expect((await updateWorkspaceSettings(owner, values)).version).toBe(2);
});

it("stores only an agent-token hash, never replays its secret, and records actual authenticated usage", async () => {
  const values = {
    commandId: randomUUID(),
    label: "Codex integration fixture",
    client: "codex" as const,
  };
  const created = await createAgentConnection(owner, values);
  expect(created.token).toMatch(/^loom_agent_[A-Za-z0-9_-]{43}$/);
  const [stored] = await readDatabase((sql) =>
    sql.query(
      "SELECT TOKEN_HASH,TOKEN_PREFIX FROM AGENT_CONNECTIONS WHERE ID=?",
      [created.connection.id],
    ),
  );
  expect(stored.TOKEN_HASH).toBe(hashToken(created.token!));
  expect(stored.TOKEN_PREFIX).toBe(created.connection.tokenPrefix);
  const [command] = await readDatabase((sql) =>
    sql.query(
      "SELECT RESULT_JSON FROM COMMAND_RECEIPTS WHERE WORKSPACE_ID=? AND COMMAND_ID=?",
      [workspaceId, values.commandId],
    ),
  );
  expect(String(command.RESULT_JSON)).not.toContain(created.token!);
  expect(await createAgentConnection(owner, values)).toEqual({
    connection: created.connection,
    token: null,
  });
  expect(JSON.stringify(await listAgentConnections(owner))).not.toContain(
    created.token!,
  );
  expect((await authenticateAgentToken(created.token!)).actor).toEqual(owner);
  await touchAgentConnection(
    created.connection.id,
    "Integration test MCP client",
  );
  const used = (await listAgentConnections(owner)).connections[0];
  expect(used.lastUsedAt).toBeTruthy();
  expect(used.clientName).toBe("Integration test MCP client");
  expect(used.version).toBe(1);
  await expect(listAgentConnections(requester)).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  await expect(
    revokeAgentConnection(foreignOwner, used.id, randomUUID(), used.version),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await writeDatabase((sql) =>
    sql.execute(
      "UPDATE MEMBERSHIPS SET \"ROLE\"='operator' WHERE WORKSPACE_ID=? AND USER_ID=?",
      [workspaceId, owner.userId],
    ),
  );
  try {
    await expect(authenticateAgentToken(created.token!)).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
  } finally {
    await writeDatabase((sql) =>
      sql.execute(
        "UPDATE MEMBERSHIPS SET \"ROLE\"='owner' WHERE WORKSPACE_ID=? AND USER_ID=?",
        [workspaceId, owner.userId],
      ),
    );
  }
  const revokeCommand = randomUUID(),
    revoked = await revokeAgentConnection(
      owner,
      used.id,
      revokeCommand,
      used.version,
    );
  expect(revoked.revokedAt).toBeTruthy();
  expect(revoked.version).toBe(2);
  expect(
    await revokeAgentConnection(owner, used.id, revokeCommand, used.version),
  ).toEqual(revoked);
  await expect(authenticateAgentToken(created.token!)).rejects.toMatchObject({
    code: "AGENT_UNAUTHORIZED",
  });
  await expect(touchAgentConnection(used.id)).rejects.toMatchObject({
    code: "AGENT_UNAUTHORIZED",
  });
});
