import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { readDatabase, writeDatabase } from "@loom/db-exasol";
import type { Actor } from "@loom/contracts";
import {
  connectSlack,
  disconnectSourceConnection,
  saveSourceConnection,
  startMicrosoftSignin,
  pollMicrosoftSignin,
  sourceRuntime,
} from "../../apps/web/server/source-connections";
import {
  changeSource,
  selectSource,
  sourceSnapshot,
  syncOneSource,
} from "../../apps/web/server/sources";
import {
  getRequest,
  membership,
  mutateRequest,
} from "../../apps/web/server/desk";
import { approvedKnowledge } from "../../apps/web/server/knowledge";

const owner: Actor = { workspaceId: randomUUID(), userId: randomUUID() },
  other: Actor = { workspaceId: randomUUID(), userId: randomUUID() },
  requester: Actor = { workspaceId: owner.workspaceId, userId: randomUUID() };
beforeAll(async () => {
  vi.stubEnv("LOOM_PROVIDER_ENCRYPTION_KEY", "87".repeat(32));
  vi.stubEnv(
    "LOOM_MICROSOFT_CLIENT_ID",
    "12345678-1234-4234-8234-123456789012",
  );
  vi.stubEnv(
    "LOOM_MICROSOFT_TENANT_ID",
    "12345678-1234-4234-8234-123456789013",
  );
  await writeDatabase(async (sql) => {
    for (const actor of [owner, other])
      await sql.execute("INSERT INTO WORKSPACES (ID,NAME) VALUES (?,?)", [
        actor.workspaceId,
        "Connected source integration fixture",
      ]);
    for (const actor of [owner, other, requester])
      await sql.execute(
        "INSERT INTO MEMBERSHIPS (WORKSPACE_ID,USER_ID,NAME,ROLE,ACTIVE,VERSION) VALUES (?,?,?,?,TRUE,1)",
        [
          actor.workspaceId,
          actor.userId,
          "Source fixture",
          actor === requester ? "requester" : "owner",
        ],
      );
  });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  vi.unstubAllEnvs();
  await writeDatabase(async (sql) => {
    for (const table of [
      "SOURCE_SIGNINS",
      "SOURCE_ITEMS",
      "CONNECTED_SOURCES",
      "SOURCE_CONNECTIONS",
      "AGENT_EVENTS",
      "KNOWLEDGE_ENTRIES",
      "COMMAND_RECEIPTS",
      "COMMENTS",
      "AUDIT_EVENTS",
      "OUTBOX_EVENTS",
      "REQUEST_EVENTS",
      "REQUESTS",
      "MEMBERSHIPS",
      "WORKSPACES",
    ])
      for (const actor of [owner, other])
        await sql.execute(
          `DELETE FROM ${table} WHERE ${table === "WORKSPACES" ? "ID" : "WORKSPACE_ID"}=?`,
          [actor.workspaceId],
        );
  });
});
const slackToken = "xoxb-synthetic-source-test-not-real";
function slackMock(text = "Can you explain the revenue drop?") {
  return vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.pathname.endsWith("auth.test"))
      return Response.json({
        ok: true,
        team_id: "TFIXTURE",
        team: "Synthetic Slack",
      });
    if (url.pathname.endsWith("conversations.info"))
      return Response.json({
        ok: true,
        channel: {
          id: "CINTAKE",
          name: "analytics-intake",
          is_private: false,
          is_member: true,
        },
      });
    if (url.pathname.endsWith("conversations.history"))
      return Response.json({
        ok: true,
        messages: [{ ts: "1700000000.123456", user: "UANALYST", text }],
      });
    if (url.pathname.endsWith("chat.getPermalink"))
      return Response.json({
        ok: true,
        permalink:
          "https://fixture.slack.com/archives/CINTAKE/p1700000000123456",
      });
    throw new Error("Unexpected source fixture endpoint");
  });
}
async function due(id: string) {
  await writeDatabase((sql) =>
    sql.execute(
      "UPDATE CONNECTED_SOURCES SET NEXT_SYNC_AT=TIMESTAMP '2000-01-01 00:00:00' WHERE WORKSPACE_ID=? AND ID=?",
      [owner.workspaceId, id],
    ),
  );
}
async function records() {
  return readDatabase((sql) =>
    sql.query("SELECT * FROM REQUESTS WHERE WORKSPACE_ID=?", [
      owner.workspaceId,
    ]),
  );
}
it("authorizes source administration before reading upstream content", async () => {
  const fetch = slackMock();
  vi.stubGlobal("fetch", fetch);
  await expect(connectSlack(requester, slackToken)).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  await expect(sourceSnapshot(requester)).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  expect(fetch).not.toHaveBeenCalled();
});
it("imports Slack automatically, scopes and encrypts tokens, deduplicates retries, and preserves manual edits", async () => {
  vi.stubGlobal("fetch", slackMock());
  await connectSlack(owner, slackToken);
  const selection = {
    provider: "slack" as const,
    rootId: "CINTAKE",
    parentId: "",
    shareWithWorkspace: true as const,
  };
  const source = await selectSource(owner, selection);
  expect((await selectSource(owner, selection)).id).toBe(source.id);
  await syncOneSource(owner.workspaceId, source.id);
  let saved = await records();
  expect(saved).toHaveLength(1);
  const requestId = String(saved[0].ID);
  expect(saved[0].SOURCE_JSON).toContain("fixture.slack.com");
  expect(saved[0].STATUS).toBe("needs_info");
  const snapshot = await sourceSnapshot(owner);
  expect(snapshot.sources[0].imported).toBe(1);
  expect(snapshot.sources[0].error).toBeNull();
  expect(JSON.stringify(snapshot)).not.toContain(slackToken);
  const [credential] = await readDatabase((sql) =>
    sql.query(
      "SELECT CREDENTIAL FROM SOURCE_CONNECTIONS WHERE WORKSPACE_ID=?",
      [owner.workspaceId],
    ),
  );
  expect(credential.CREDENTIAL).not.toContain(slackToken);
  expect((await sourceSnapshot(other)).sources).toEqual([]);
  await due(source.id);
  await syncOneSource(owner.workspaceId, source.id);
  saved = await records();
  expect(saved).toHaveLength(1);
  expect(Number(saved[0].VERSION)).toBe(1);
  vi.stubGlobal("fetch", slackMock("Can you explain October revenue?"));
  await due(source.id);
  await syncOneSource(owner.workspaceId, source.id);
  saved = await records();
  expect(saved[0].BUSINESS_QUESTION).toBe("Can you explain October revenue?");
  expect(Number(saved[0].VERSION)).toBe(2);
  const record = await readDatabase(async (sql) =>
    getRequest(sql, owner, await membership(sql, owner), requestId),
  );
  await mutateRequest(owner, requestId, randomUUID(), record.version, {
    type: "edit_description",
    values: {
      title: "Manually clarified",
      businessQuestion: "Use net revenue, excluding refunds.",
      reportingPeriod: "October",
      dataset: "Ledger",
    },
  });
  vi.stubGlobal("fetch", slackMock("Another source edit"));
  await due(source.id);
  await syncOneSource(owner.workspaceId, source.id);
  saved = await records();
  expect(saved[0].TITLE).toBe("Manually clarified");
  expect(saved[0].BUSINESS_QUESTION).toBe(
    "Use net revenue, excluding refunds.",
  );
  await changeSource(owner, source.id, "pause");
  const fetch = slackMock();
  vi.stubGlobal("fetch", fetch);
  await syncOneSource(owner.workspaceId, source.id);
  expect(fetch).not.toHaveBeenCalled();
});
it("automatically imports SharePoint references and retires deleted originals", async () => {
  await writeDatabase((sql) =>
    saveSourceConnection(
      sql,
      owner,
      "microsoft",
      "microsoft-fixture",
      "Synthetic Microsoft",
      {
        accessToken: "synthetic-microsoft-token",
        expiresAt: Date.now() + 3600000,
      },
    ),
  );
  let deleted = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname.endsWith("/drives"))
        return Response.json({
          value: [
            {
              id: "DRIVE",
              name: "Team definitions",
              driveType: "documentLibrary",
            },
          ],
        });
      if (url.pathname.endsWith("/delta"))
        return Response.json({
          value: [
            deleted
              ? { id: "DOC", deleted: {} }
              : {
                  id: "DOC",
                  name: "Revenue.md",
                  file: {},
                  size: 25,
                  webUrl: "https://fixture.sharepoint.com/Revenue.md",
                  lastModifiedDateTime: "2026-11-01T00:00:00Z",
                },
          ],
          "@odata.deltaLink":
            "https://graph.microsoft.com/v1.0/drives/DRIVE/root/delta?$deltatoken=fixture",
        });
      if (url.pathname.endsWith("/content"))
        return new Response(null, {
          status: 302,
          headers: { location: "https://fixture.sharepoint.com/download" },
        });
      return new Response("Net revenue excludes refunds.");
    }),
  );
  const source = await selectSource(owner, {
    provider: "sharepoint",
    rootId: "DRIVE",
    parentId: "SITE",
    shareWithWorkspace: true,
  });
  await syncOneSource(owner.workspaceId, source.id);
  let knowledge = await readDatabase((sql) => approvedKnowledge(sql, owner));
  expect(knowledge).toHaveLength(1);
  expect(knowledge[0]).toMatchObject({
    kind: "reference",
    state: "approved",
    content: "Net revenue excludes refunds.",
  });
  expect(knowledge[0].externalSource?.url).toContain("sharepoint.com");
  await due(source.id);
  await syncOneSource(owner.workspaceId, source.id);
  knowledge = await readDatabase((sql) => approvedKnowledge(sql, owner));
  expect(knowledge[0].version).toBe(1);
  deleted = true;
  await due(source.id);
  await syncOneSource(owner.workspaceId, source.id);
  expect(await readDatabase((sql) => approvedKnowledge(sql, owner))).toEqual(
    [],
  );
});
it("discards fetched content if a source is paused before persistence", async () => {
  vi.stubGlobal("fetch", slackMock());
  const source = await selectSource(owner, {
    provider: "slack",
    rootId: "CINTAKE",
    parentId: "",
    shareWithWorkspace: true,
  });
  const before = await records();
  const base = slackMock("Must not persist after revocation");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const result = await base(input);
      if (input.includes("conversations.history"))
        await changeSource(owner, source.id, "pause");
      return result;
    }),
  );
  await syncOneSource(owner.workspaceId, source.id);
  expect(await records()).toEqual(before);
  await disconnectSourceConnection(owner, "slack");
});
it("binds Microsoft device sign-in to its initiating owner and stores only encrypted device codes", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        device_code: "private-fixture-device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://microsoft.com/devicelogin",
        expires_in: 900,
        interval: 5,
      }),
    ),
  );
  const signin = await startMicrosoftSignin(owner);
  expect(JSON.stringify(signin)).not.toContain("private-fixture-device-code");
  const [pending] = await readDatabase((sql) =>
    sql.query("SELECT CREDENTIAL FROM SOURCE_SIGNINS WHERE WORKSPACE_ID=?", [
      owner.workspaceId,
    ]),
  );
  expect(pending.CREDENTIAL).not.toContain("private-fixture-device-code");
  await expect(pollMicrosoftSignin(other, signin.id)).rejects.toMatchObject({
    code: "SIGNIN_EXPIRED",
  });
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect(await pollMicrosoftSignin(owner, signin.id)).toEqual({
    connected: false,
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("completes Microsoft consent, renews tokens, and never exposes the device or refresh token", async () => {
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith("/devicecode"))
      return Response.json({
        device_code: "private-device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://microsoft.com/devicelogin",
        expires_in: 900,
        interval: 5,
      });
    if (input.endsWith("/token")) {
      const form = new URLSearchParams(String(init?.body));
      if (form.get("grant_type") === "refresh_token") {
        expect(form.get("refresh_token")).toBe("private-refresh-token");
        return Response.json({
          access_token: "refreshed-microsoft-token",
          refresh_token: "rotated-refresh-token",
          expires_in: 3600,
        });
      }
      expect(form.get("device_code")).toBe("private-device-code");
      return Response.json({
        access_token: "first-microsoft-token",
        refresh_token: "private-refresh-token",
        expires_in: 60,
      });
    }
    return Response.json({
      id: "microsoft-user",
      displayName: "Connected Microsoft fixture",
    });
  });
  vi.stubGlobal("fetch", fetch);
  const signin = await startMicrosoftSignin(owner);
  await writeDatabase((sql) =>
    sql.execute(
      "UPDATE SOURCE_SIGNINS SET NEXT_POLL_AT=TIMESTAMP '2000-01-01 00:00:00' WHERE WORKSPACE_ID=? AND OWNER_ID=?",
      [owner.workspaceId, owner.userId],
    ),
  );
  expect(await pollMicrosoftSignin(owner, signin.id)).toEqual({
    connected: true,
  });
  expect((await sourceRuntime(owner, "microsoft")).token).toBe(
    "refreshed-microsoft-token",
  );
  const snapshot = await sourceSnapshot(owner);
  expect(
    snapshot.connections.find(
      (connection) => connection.provider === "microsoft",
    )?.name,
  ).toBe("Connected Microsoft fixture");
  expect(JSON.stringify(snapshot)).not.toMatch(
    /private-device-code|private-refresh-token|rotated-refresh-token/,
  );
  expect(
    await readDatabase((sql) =>
      sql.query("SELECT ID FROM SOURCE_SIGNINS WHERE WORKSPACE_ID=?", [
        owner.workspaceId,
      ]),
    ),
  ).toEqual([]);
});
