import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import {
  defaultWorkspaceSettings,
  updateWorkspaceSettingsSchema,
  workspaceBrandingSchema,
  type Actor,
  type UpdateWorkspaceSettings,
} from "@loom/contracts";

const database = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn() }));
vi.mock("@loom/db-exasol", async (original) => ({
  ...(await original<typeof import("@loom/db-exasol")>()),
  readDatabase: async (work: (sql: typeof database) => unknown) =>
    work(database),
  writeDatabase: async (work: (sql: typeof database) => unknown) =>
    work(database),
}));
import {
  authenticateAgentToken,
  assertAgentConnection,
  createAgentConnection,
  listAgentConnections,
  readWorkspaceSettings,
  revokeAgentConnection,
  touchAgentConnection,
  updateWorkspaceSettings,
} from "../apps/web/server/settings";
import { hashToken } from "../apps/web/server/identity-crypto";

const actor: Actor = { userId: randomUUID(), workspaceId: randomUUID() };
let role: string | null;
const settings = new Map<string, Record<string, unknown>>();
const receipts = new Map<string, Record<string, unknown>>();
const connections = new Map<string, Record<string, unknown>>();
function input(): UpdateWorkspaceSettings {
  return {
    commandId: randomUUID(),
    expectedVersion: 0,
    branding: {
      ...defaultWorkspaceSettings.branding,
      companyName: "Acme",
      primaryColor: "#2244aa",
      accentColor: "#ffcc55",
    },
    preferredAgent: "codex",
    completeSetup: true,
  };
}
beforeEach(() => {
  role = "owner";
  settings.clear();
  receipts.clear();
  connections.clear();
  database.query
    .mockReset()
    .mockImplementation(async (sql: string, values: unknown[]) => {
      if (sql.includes("FROM MEMBERSHIPS"))
        return values[0] === actor.workspaceId &&
          values[1] === actor.userId &&
          role
          ? [{ USER_ID: actor.userId, NAME: "Owner", ROLE: role }]
          : [];
      if (sql.includes("FROM COMMAND_RECEIPTS"))
        return receipts.has(String(values[1]))
          ? [receipts.get(String(values[1]))]
          : [];
      if (sql.includes("FROM TOOL_GENERATIONS")) return [];
      if (sql.includes("FROM WORKSPACE_SETTINGS"))
        return settings.has(String(values[0]))
          ? [settings.get(String(values[0]))]
          : [];
      if (sql.includes("FROM AGENT_CONNECTIONS")) {
        const rows = [...connections.values()];
        if (sql.includes("COUNT(*)"))
          return [
            {
              TOTAL: rows.filter(
                (row) =>
                  row.WORKSPACE_ID === values[0] &&
                  !row.REVOKED_AT &&
                  String(row.EXPIRES_AT) > String(values[1]),
              ).length,
            },
          ];
        if (sql.includes("TOKEN_HASH=?"))
          return rows.filter((row) => row.TOKEN_HASH === values[0]);
        if (sql.includes("WORKSPACE_ID=? AND ID=?"))
          return rows.filter(
            (row) => row.WORKSPACE_ID === values[0] && row.ID === values[1],
          );
        if (sql.includes("WHERE ID=?"))
          return rows.filter((row) => row.ID === values[0]);
        return rows.filter((row) => row.WORKSPACE_ID === values[0]);
      }
      return [];
    });
  database.execute
    .mockReset()
    .mockImplementation(async (sql: string, values: unknown[]) => {
      if (sql.startsWith("INSERT INTO WORKSPACE_SETTINGS"))
        settings.set(String(values[0]), {
          VERSION: values[1],
          SETTINGS_JSON: values[2],
        });
      if (sql.startsWith("UPDATE WORKSPACE_SETTINGS")) {
        const row = settings.get(String(values[4]));
        if (!row || row.VERSION !== values[5]) return 0;
        row.VERSION = values[0];
        row.SETTINGS_JSON = values[1];
      }
      if (sql.startsWith("INSERT INTO COMMAND_RECEIPTS"))
        receipts.set(String(values[1]), {
          ACTOR_ID: values[2],
          PAYLOAD_HASH: values[3],
          RESULT_JSON: values[4],
        });
      if (sql.startsWith("INSERT INTO AGENT_CONNECTIONS"))
        connections.set(String(values[0]), {
          ID: values[0],
          WORKSPACE_ID: values[1],
          VERSION: 1,
          LABEL: values[2],
          CLIENT: values[3],
          CREATED_BY: values[4],
          TOKEN_HASH: values[5],
          TOKEN_PREFIX: values[6],
          CREATED_AT: values[7],
          EXPIRES_AT: values[8],
          REVOKED_AT: null,
          LAST_USED_AT: null,
          CLIENT_NAME: null,
        });
      if (sql.startsWith("UPDATE AGENT_CONNECTIONS SET REVOKED_AT")) {
        const row = connections.get(String(values[2]));
        if (!row || row.VERSION !== values[3]) return 0;
        row.REVOKED_AT = values[0];
        row.VERSION = Number(row.VERSION) + 1;
      }
      if (sql.startsWith("UPDATE AGENT_CONNECTIONS SET LAST_USED_AT")) {
        const row = connections.get(String(values[3]))!;
        row.LAST_USED_AT = values[0];
        row.CLIENT_NAME = values[1] || row.CLIENT_NAME;
      }
      return 1;
    });
});

it("validates constrained brand values and rejects executable or disguised logos", async () => {
  expect(
    workspaceBrandingSchema.parse({
      ...defaultWorkspaceSettings.branding,
      primaryColor: "#AABBCC",
    }).primaryColor,
  ).toBe("#aabbcc");
  for (const branding of [
    {
      ...defaultWorkspaceSettings.branding,
      primaryColor: "red; background:url(example)",
    },
    {
      ...defaultWorkspaceSettings.branding,
      logoDataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
    },
    {
      ...defaultWorkspaceSettings.branding,
      logoDataUrl: "https://tracker.example/logo.png",
    },
  ])
    expect(workspaceBrandingSchema.safeParse(branding).success).toBe(false);
  expect(
    updateWorkspaceSettingsSchema.safeParse({
      ...input(),
      branding: defaultWorkspaceSettings.branding,
    }).success,
  ).toBe(false);
  await expect(
    updateWorkspaceSettings(actor, {
      ...input(),
      branding: {
        ...input().branding,
        logoDataUrl: "data:image/png;base64,PHN2Zy8+",
      },
    }),
  ).rejects.toMatchObject({ code: "INVALID_BRAND_LOGO" });
  expect(database.execute).not.toHaveBeenCalled();
});

it("defaults without writes and lets only owners save optimistic, replay-safe settings", async () => {
  expect(await readWorkspaceSettings(actor)).toEqual(defaultWorkspaceSettings);
  expect(database.execute).not.toHaveBeenCalled();
  for (const denied of ["operator", "requester", "viewer"]) {
    role = denied;
    expect(await readWorkspaceSettings(actor)).toEqual(
      defaultWorkspaceSettings,
    );
    await expect(updateWorkspaceSettings(actor, input())).rejects.toMatchObject(
      { code: "ACCESS_DENIED" },
    );
  }
  role = "owner";
  const values = input(),
    saved = await updateWorkspaceSettings(actor, values);
  expect(saved.version).toBe(1);
  expect(saved.setupCompletedAt).toBeTruthy();
  expect(await updateWorkspaceSettings(actor, values)).toEqual(saved);
  await expect(
    updateWorkspaceSettings(actor, {
      ...values,
      branding: { ...values.branding, companyName: "Another" },
    }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  await expect(updateWorkspaceSettings(actor, input())).rejects.toMatchObject({
    code: "SETTINGS_VERSION_CONFLICT",
  });
  const edited = await updateWorkspaceSettings(actor, {
    ...input(),
    expectedVersion: 1,
    completeSetup: false,
  });
  expect(edited.version).toBe(2);
  expect(edited.setupCompletedAt).toBe(saved.setupCompletedAt);
  await expect(
    readWorkspaceSettings({ ...actor, workspaceId: randomUUID() }),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
});

it("returns a raw agent token only on creation and never stores it in SQL receipts or lists", async () => {
  const values = {
    commandId: randomUUID(),
    label: "Design team Codex",
    client: "codex" as const,
  };
  const created = await createAgentConnection(actor, values);
  expect(created.token).toMatch(/^loom_agent_[A-Za-z0-9_-]{43}$/);
  const stored = connections.get(created.connection.id)!;
  expect(stored.TOKEN_HASH).toBe(hashToken(created.token!));
  expect(JSON.stringify(database.execute.mock.calls)).not.toContain(
    created.token,
  );
  expect(await createAgentConnection(actor, values)).toEqual({
    connection: created.connection,
    token: null,
  });
  const listed = await listAgentConnections(actor);
  expect(listed.connections).toEqual([created.connection]);
  expect(JSON.stringify(listed)).not.toContain(stored.TOKEN_HASH);
  expect(JSON.stringify(listed)).not.toContain(created.token);
  expect((await authenticateAgentToken(created.token!)).actor).toEqual(actor);
  expect(created.connection.lastUsedAt).toBeNull();
  await touchAgentConnection(created.connection.id, "Codex\u0000 CLI");
  const touched = (await listAgentConnections(actor)).connections[0];
  expect(touched.lastUsedAt).toBeTruthy();
  expect(touched.clientName).toBe("Codex CLI");
  expect(touched.version).toBe(1);
});

it("rechecks owner membership, workspace, expiry and revocation at every agent operation", async () => {
  const created = await createAgentConnection(actor, {
    commandId: randomUUID(),
    label: "Agent",
    client: "other",
  });
  const stored = connections.get(created.connection.id)!;
  for (const denied of ["operator", "requester", "viewer", null]) {
    role = denied;
    await expect(authenticateAgentToken(created.token!)).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    await expect(listAgentConnections(actor)).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    await expect(
      touchAgentConnection(created.connection.id),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  }
  role = "owner";
  await expect(
    assertAgentConnection(
      database,
      { ...actor, workspaceId: randomUUID() },
      created.connection.id,
    ),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  stored.EXPIRES_AT = "2000-01-01T00:00:00.000Z";
  await expect(authenticateAgentToken(created.token!)).rejects.toMatchObject({
    code: "AGENT_UNAUTHORIZED",
  });
  stored.EXPIRES_AT = "2099-01-01T00:00:00.000Z";
  const command = randomUUID();
  const revoked = await revokeAgentConnection(
    actor,
    created.connection.id,
    command,
    1,
  );
  expect(revoked.revokedAt).toBeTruthy();
  expect(revoked.version).toBe(2);
  expect(
    await revokeAgentConnection(actor, created.connection.id, command, 1),
  ).toEqual(revoked);
  await expect(authenticateAgentToken(created.token!)).rejects.toMatchObject({
    code: "AGENT_UNAUTHORIZED",
  });
  await expect(
    touchAgentConnection(created.connection.id),
  ).rejects.toMatchObject({ code: "AGENT_UNAUTHORIZED" });
  await expect(authenticateAgentToken("not-a-token")).rejects.toMatchObject({
    code: "AGENT_UNAUTHORIZED",
  });
  await expect(
    authenticateAgentToken(`loom_agent_${"a".repeat(43)}`),
  ).rejects.toMatchObject({ code: "AGENT_UNAUTHORIZED" });
});
