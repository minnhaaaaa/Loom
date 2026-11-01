import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { readDatabase, writeDatabase } from "@loom/db-exasol";
import type { Actor } from "@loom/contracts";
import {
  connectSlack,
  connectGithub,
  connectDiscord,
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
  reviewSourceItem,
  setRequestMode,
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
      "SOURCE_DOCUMENT_PARTS",
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

it("detects general-chat requests, holds uncertain messages for scoped review, and remembers dismissals", async () => {
  const baseline = (await records()).length;
  let uncertain = "Why did revenue drop?";
  const upstream = slackMock();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (new URL(input).pathname.endsWith("conversations.history"))
        return Response.json({
          ok: true,
          messages: [
            {
              ts: "1800000001.1",
              user: "U1",
              text: "Can you analyze conversion by region?",
            },
            { ts: "1800000002.1", user: "U2", text: uncertain },
            {
              ts: "1800000003.1",
              user: "U3",
              text: "Good morning, the dashboard is published.",
            },
          ],
        });
      return upstream(input);
    }),
  );
  await connectSlack(owner, slackToken);
  const source = await selectSource(owner, {
    provider: "slack",
    rootId: "CINTAKE",
    parentId: "",
    shareWithWorkspace: true,
    requestMode: "detect",
  });
  await syncOneSource(owner.workspaceId, source.id);
  expect((await records()).length).toBe(baseline + 1);
  let status = (await sourceSnapshot(owner)).sources.find(
    (s) => s.id === source.id,
  )!;
  expect(status.reviewCount).toBe(1);
  const candidate = status.review[0];
  await expect(
    reviewSourceItem(
      requester,
      source.id,
      candidate.externalId,
      candidate.hash,
      "accept",
    ),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  await expect(
    reviewSourceItem(
      other,
      source.id,
      candidate.externalId,
      candidate.hash,
      "accept",
    ),
  ).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  await expect(
    reviewSourceItem(
      owner,
      source.id,
      candidate.externalId,
      "f".repeat(64),
      "accept",
    ),
  ).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  await reviewSourceItem(
    owner,
    source.id,
    candidate.externalId,
    candidate.hash,
    "dismiss",
  );
  await due(source.id);
  await syncOneSource(owner.workspaceId, source.id);
  expect(
    (await sourceSnapshot(owner)).sources.find((s) => s.id === source.id)
      ?.reviewCount,
  ).toBe(0);
  uncertain = "Why did October revenue drop?";
  await due(source.id);
  await syncOneSource(owner.workspaceId, source.id);
  status = (await sourceSnapshot(owner)).sources.find(
    (s) => s.id === source.id,
  )!;
  expect(status.reviewCount).toBe(1);
  const changed = status.review[0];
  await reviewSourceItem(
    owner,
    source.id,
    changed.externalId,
    changed.hash,
    "accept",
  );
  await reviewSourceItem(
    owner,
    source.id,
    changed.externalId,
    changed.hash,
    "accept",
  );
  await due(source.id);
  await syncOneSource(owner.workspaceId, source.id);
  expect((await records()).length).toBe(baseline + 2);
  expect(
    (await sourceSnapshot(owner)).sources.find((s) => s.id === source.id)
      ?.reviewCount,
  ).toBe(0);
  await setRequestMode(owner, source.id, "all");
  await changeSource(owner, source.id, "pause");
  await changeSource(owner, source.id, "resume");
  expect(
    (await sourceSnapshot(owner)).sources.find((s) => s.id === source.id)
      ?.requestMode,
  ).toBe("all");
  await syncOneSource(owner.workspaceId, source.id);
  expect((await records()).length).toBe(baseline + 3);
});

it("imports all PDF pages, retrieves a late passage, replaces chunks, and retires every deleted passage", async () => {
  const { pdfFixture } = await import("../helpers/pdf");
  const { readTeamMemory } = await import("../../apps/web/server/memory");
  const { approvedKnowledgeDigest } =
    await import("../../apps/web/server/knowledge");
  await writeDatabase((sql) =>
    saveSourceConnection(
      sql,
      owner,
      "microsoft",
      "microsoft-fixture",
      "Synthetic Microsoft",
      { accessToken: "synthetic-token", expiresAt: Date.now() + 3600000 },
    ),
  );
  let pages = [
    "Revenue glossary",
    "Use the finance ledger",
    "Zebracorn reconciliation excludes refunds",
  ];
  let deleted = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname.endsWith("/drives"))
        return Response.json({
          value: [
            {
              id: "PDFDRIVE",
              name: "PDF references",
              driveType: "documentLibrary",
            },
          ],
        });
      if (url.pathname.endsWith("/delta"))
        return Response.json({
          value: [
            deleted
              ? { id: "PDF", deleted: {} }
              : {
                  id: "PDF",
                  name: "Finance.pdf",
                  file: {},
                  size: 1500,
                  webUrl: "https://fixture.sharepoint.com/Finance.pdf",
                  lastModifiedDateTime: "2026-11-01",
                },
          ],
          "@odata.deltaLink":
            "https://graph.microsoft.com/v1.0/drives/PDFDRIVE/root/delta?$deltatoken=fixture",
        });
      if (url.pathname.endsWith("/content"))
        return new Response(Buffer.from(pdfFixture(pages)));
      throw new Error("Unexpected PDF endpoint");
    }),
  );
  const source = await selectSource(owner, {
    provider: "sharepoint",
    rootId: "PDFDRIVE",
    parentId: "SITE",
    shareWithWorkspace: true,
  });
  await syncOneSource(owner.workspaceId, source.id);
  const corpus = () =>
    readDatabase(async (sql) =>
      (await approvedKnowledge(sql, owner)).filter(
        (entry) => entry.externalSource?.sourceId === source.id,
      ),
    );
  const imported = await corpus();
  expect(imported).toHaveLength(3);
  expect(
    (await sourceSnapshot(owner)).sources.find((s) => s.id === source.id)
      ?.imported,
  ).toBe(1);
  const late = imported.find((entry) => entry.content.includes("Zebracorn"))!;
  expect(late.externalSource?.page).toBe(3);
  expect(late.title).toContain("p. 3");
  const search = await readTeamMemory(owner, { q: "Zebracorn" });
  expect(JSON.stringify(search)).toContain(late.id);
  const firstDigest = await readDatabase((sql) =>
    approvedKnowledgeDigest(sql, owner),
  );
  await due(source.id);
  await syncOneSource(owner.workspaceId, source.id);
  expect((await corpus()).map((entry) => entry.version)).toEqual([1, 1, 1]);
  pages = ["Revenue glossary updated", "Revised finance ledger"];
  await due(source.id);
  await syncOneSource(owner.workspaceId, source.id);
  const updated = await corpus();
  expect(updated).toHaveLength(2);
  expect(
    updated.every((entry) => imported.some((before) => before.id === entry.id)),
  ).toBe(true);
  expect(
    await readDatabase((sql) => approvedKnowledgeDigest(sql, owner)),
  ).not.toBe(firstDigest);
  expect(
    JSON.stringify(await readTeamMemory(owner, { q: "Zebracorn" })),
  ).not.toContain(late.content);
  deleted = true;
  await due(source.id);
  await syncOneSource(owner.workspaceId, source.id);
  expect(await corpus()).toEqual([]);
});

it("stores GitHub credentials encrypted and retires deleted code without duplicating repository history", async () => {
  const token = "github_pat_synthetic_integration_token";
  const commit = "a".repeat(40),
    tree = "b".repeat(40),
    blob = "c".repeat(40);
  const text = "SELECT SUM(net_revenue) FROM github_orders;";
  let files = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      if (path === "/user")
        return Response.json({ id: 42, login: "github-fixture" });
      if (path === "/user/repos")
        return Response.json([{ id: 123, full_name: "fixture/analytics" }]);
      if (path === "/repos/fixture/analytics")
        return Response.json({
          id: 123,
          full_name: "fixture/analytics",
          default_branch: "main",
        });
      if (path.endsWith("/commits"))
        return Response.json([
          { sha: commit, commit: { tree: { sha: tree } } },
        ]);
      if (path.includes("/trees/"))
        return Response.json({
          sha: tree,
          truncated: false,
          tree: files
            ? [
                {
                  path: "revenue.sql",
                  type: "blob",
                  mode: "100644",
                  sha: blob,
                  size: text.length,
                },
              ]
            : [],
        });
      if (path.includes("/blobs/"))
        return Response.json({
          sha: blob,
          encoding: "base64",
          size: text.length,
          content: Buffer.from(text).toString("base64"),
        });
      if (path.endsWith("/issues"))
        return Response.json([
          {
            id: 99,
            number: 4,
            title: "Repository refunds discussion",
            body: "Githubfixture refunds guidance",
            state: "closed",
            comments: 0,
            user: { login: "analyst" },
            updated_at: "2026-11-01T00:00:00Z",
          },
        ]);
      throw new Error("Unexpected GitHub fixture endpoint");
    }),
  );
  await expect(connectGithub(requester, token)).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  await connectGithub(owner, token);
  const [stored] = await readDatabase((sql) =>
    sql.query(
      "SELECT CREDENTIAL FROM SOURCE_CONNECTIONS WHERE WORKSPACE_ID=? AND PROVIDER='github'",
      [owner.workspaceId],
    ),
  );
  expect(String(stored.CREDENTIAL)).not.toContain(token);
  expect((await sourceRuntime(owner, "github")).token).toBe(token);
  const source = await selectSource(owner, {
    provider: "github",
    rootId: "123",
    shareWithWorkspace: true,
  });
  await syncOneSource(owner.workspaceId, source.id);
  await due(source.id);
  await syncOneSource(owner.workspaceId, source.id);
  const corpus = () =>
    readDatabase(async (sql) =>
      (await approvedKnowledge(sql, owner)).filter(
        (entry) => entry.externalSource?.sourceId === source.id,
      ),
    );
  const first = await corpus();
  expect(first).toHaveLength(2);
  expect(
    first.every((entry) => entry.externalSource?.provider === "github"),
  ).toBe(true);
  await due(source.id);
  await syncOneSource(owner.workspaceId, source.id);
  await due(source.id);
  await syncOneSource(owner.workspaceId, source.id);
  expect((await corpus()).map((entry) => entry.version)).toEqual(
    first.map((entry) => entry.version),
  );
  files = false;
  await due(source.id);
  await syncOneSource(owner.workspaceId, source.id);
  expect(await corpus()).toHaveLength(1);
  expect((await corpus())[0].externalSource?.externalId).toBe("issue:99");
  // Restoring an identical revision after deletion must restore its original passage ID.
  await due(source.id);
  await syncOneSource(owner.workspaceId, source.id);
  files = true;
  await due(source.id);
  await syncOneSource(owner.workspaceId, source.id);
  expect((await corpus()).map((entry) => entry.id).sort()).toEqual(
    first.map((entry) => entry.id).sort(),
  );
});

it("requires a Discord bot and keeps reconnect/disconnect isolated from other providers", async () => {
  const token = "synthetic_discord_bot_token";
  let botAccount = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input.endsWith("users/@me"))
        return Response.json({
          id: "323456789012345678",
          username: "Fixture bot",
          bot: botAccount,
        });
      if (input.endsWith("applications/@me"))
        return Response.json({ flags: 1 << 19, name: "Fixture bot" });
      throw new Error("Unexpected Discord fixture endpoint");
    }),
  );
  await expect(connectDiscord(requester, token)).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  await expect(connectDiscord(owner, token)).rejects.toThrow("bot token");
  botAccount = true;
  await connectDiscord(owner, token);
  expect((await sourceRuntime(owner, "discord")).token).toBe(token);
  await disconnectSourceConnection(owner, "discord");
  expect(
    (await sourceSnapshot(owner)).sources.find(
      (source) => source.provider === "github",
    )?.active,
  ).toBe(true);
  expect(
    (await sourceSnapshot(owner)).connections.some(
      (connection) => connection.provider === "github",
    ),
  ).toBe(true);
});

it("retrieves a matching passage beyond 500 references while tracking unseen corpus changes", async () => {
  const { knowledgeInputSchema } = await import("@loom/contracts");
  const { digest } = await import("../../apps/web/server/desk");
  const { approvedKnowledgeDigest } =
    await import("../../apps/web/server/knowledge");
  const ids: string[] = [];
  await writeDatabase(async (sql) => {
    const values: string[] = [];
    const tuples: string[] = [];
    for (let i = 0; i < 502; i++) {
      const id = randomUUID();
      ids.push(id);
      const content = knowledgeInputSchema.parse({
        title: `Reference ${i}`,
        kind: "reference",
        content:
          i === 501
            ? "Quasarneedle settlement procedure"
            : "Ordinary archived terminology",
        effectiveFrom: "2020-01-01",
      });
      tuples.push(
        "(?,?,1,'approved','reference',NULL,?,?,?,TIMESTAMP '2026-11-01 00:00:00',?)",
      );
      values.push(
        owner.workspaceId,
        id,
        JSON.stringify(content),
        digest(content),
        owner.userId,
        owner.userId,
      );
    }
    await sql.execute(
      `INSERT INTO KNOWLEDGE_ENTRIES (WORKSPACE_ID,ID,VERSION,LIFECYCLE,KIND,DATASET,CONTENT_JSON,CONTENT_HASH,CREATED_BY,CREATED_AT,APPROVED_BY) VALUES ${tuples.join(",")}`,
      values,
    );
  });
  const matches = await readDatabase((sql) =>
    approvedKnowledge(sql, owner, "Quasarneedle"),
  );
  expect(matches).toHaveLength(1);
  expect(matches[0].id).toBe(ids[501]);
  const before = await readDatabase((sql) =>
    approvedKnowledgeDigest(sql, owner),
  );
  await writeDatabase((sql) =>
    sql.execute(
      "UPDATE KNOWLEDGE_ENTRIES SET LIFECYCLE='retired',VERSION=VERSION+1 WHERE WORKSPACE_ID=? AND ID=?",
      [owner.workspaceId, ids[0]],
    ),
  );
  expect(
    await readDatabase((sql) => approvedKnowledgeDigest(sql, owner)),
  ).not.toBe(before);
});
