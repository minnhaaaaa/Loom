import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultWorkspaceSettings, type Actor } from "@loom/contracts";
import { DomainError } from "@loom/domain";
import { readDatabase, writeDatabase, sqlTimestamp } from "@loom/db-exasol";
import {
  OPENAI_ISSUER,
  OPENAI_PLAN_SCOPES,
  oauthDigest,
  type OpenAiTokens,
} from "../apps/web/server/openai-oauth";
import {
  assertOpenAiPlanCurrent,
  completeOpenAiConnection,
  disconnectOpenAiIdentity,
  getOpenAiPlanCredential,
  readOpenAiConnection,
  readOpenAiPlanStatus,
  saveOpenAiIdentity,
  startOpenAiConnection,
  takeOpenAiTransaction,
  updateOpenAiModel,
} from "../apps/web/server/openai-oauth-store";
import {
  conversationConfiguration,
  sendConversation,
} from "../apps/web/server/conversation";
import { generateToolDraft, toolWorkspace } from "../apps/web/server/tools";
import { startRun } from "../apps/web/server/triage";

// Deliberately excluded from both normal unit and default-schema integration runs.
if (process.env.EXASOL_SCHEMA !== "LOOM_TEST_LOCAL_OAUTH")
  throw new Error(
    "OAuth database checks require the dedicated LOOM_TEST_LOCAL_OAUTH schema.",
  );

const boundary = vi.hoisted(() => ({
  exchange: vi.fn(),
  refresh: vi.fn(),
  revoke: vi.fn(),
  discovery: vi.fn(),
  infer: vi.fn(),
  design: vi.fn(),
  triage: vi.fn(),
}));
vi.mock("../apps/web/server/openai-oauth", async (original) => ({
  ...(await original<typeof import("../apps/web/server/openai-oauth")>()),
  discoverOpenAi: boundary.discovery,
  exchangeOpenAiCode: boundary.exchange,
  refreshOpenAiTokens: boundary.refresh,
  revokeOpenAiTokens: boundary.revoke,
}));
vi.mock("../apps/web/server/conversation-model", async (original) => ({
  ...(await original<typeof import("../apps/web/server/conversation-model")>()),
  inferConversation: boundary.infer,
}));
vi.mock("../apps/web/server/tool-generation", async (original) => ({
  ...(await original<typeof import("../apps/web/server/tool-generation")>()),
  generateDefinition: boundary.design,
}));
vi.mock("../apps/web/server/openrouter", async (original) => ({
  ...(await original<typeof import("../apps/web/server/openrouter")>()),
  inferProposal: boundary.triage,
}));

let owner: Actor, anotherOwner: Actor, operator: Actor, session: string;
let clientId: string, subject: string;
const hostId = `urn:uuid:${randomUUID()}`;
const actors: Actor[] = [];
function tokens(expired = false): OpenAiTokens {
  return {
    idToken: "synthetic-id-token",
    accessToken: "synthetic-access-token",
    refreshToken: "synthetic-refresh-token",
    scopes: ["openid", "profile", "email", ...OPENAI_PLAN_SCOPES],
    expiresAt: Date.now() + (expired ? -1000 : 3600_000),
    earliestRefreshAt: 0,
    nonce: "synthetic-nonce",
  };
}
function identity() {
  return {
    issuer: OPENAI_ISSUER,
    clientId,
    subject,
    email: "oauth-fixture@example.test",
    name: "OAuth fixture",
  };
}
beforeEach(async () => {
  actors.splice(0);
  owner = { workspaceId: randomUUID(), userId: randomUUID() };
  anotherOwner = { workspaceId: owner.workspaceId, userId: randomUUID() };
  operator = { workspaceId: owner.workspaceId, userId: randomUUID() };
  actors.push(owner, anotherOwner, operator);
  session = randomBytes(32).toString("base64url");
  clientId = `oaiapp_fixture_${randomUUID().replaceAll("-", "")}`;
  subject = `fixture-${randomUUID()}`;
  vi.stubEnv("LOOM_OPENAI_LOCAL_ENABLED", "true");
  vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3000");
  vi.stubEnv("LOOM_PROVIDER_ENCRYPTION_KEY", "3f".repeat(32));
  vi.stubEnv("LOOM_OPENAI_HOST_ID", hostId);
  vi.stubEnv("LOOM_CHATGPT_MODEL", "synthetic-model");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected live provider call in database integration");
    }),
  );
  boundary.discovery.mockReset().mockResolvedValue({
    issuer: OPENAI_ISSUER,
    authorizationEndpoint: `${OPENAI_ISSUER}/api/accounts/authorize`,
    tokenEndpoint: `${OPENAI_ISSUER}/api/accounts/oauth/token`,
    jwksUri: `${OPENAI_ISSUER}/.well-known/jwks.json`,
    revocationEndpoint: `${OPENAI_ISSUER}/oauth/revoke`,
    algorithms: ["RS256"],
  });
  boundary.exchange.mockReset().mockImplementation(async () => ({
    identity: identity(),
    tokens: tokens(),
  }));
  boundary.refresh.mockReset().mockImplementation(async () => tokens());
  boundary.revoke.mockReset().mockResolvedValue(true);
  boundary.infer.mockReset();
  boundary.design.mockReset();
  boundary.triage.mockReset();
  await writeDatabase(async (sql) => {
    const now = sqlTimestamp(new Date().toISOString());
    await sql.execute("INSERT INTO WORKSPACES (ID,NAME) VALUES (?,?)", [
      owner.workspaceId,
      "Isolated local OAuth integration",
    ]);
    for (const actor of actors) {
      await sql.execute(
        "INSERT INTO AUTH_USERS (ID,NAME,CREATED_AT) VALUES (?,?,?)",
        [actor.userId, "OAuth fixture", now],
      );
      await sql.execute(
        "INSERT INTO MEMBERSHIPS (WORKSPACE_ID,USER_ID,NAME,ROLE,ACTIVE,VERSION) VALUES (?,?,?,?,TRUE,1)",
        [
          actor.workspaceId,
          actor.userId,
          "OAuth fixture",
          actor === operator ? "operator" : "owner",
        ],
      );
    }
    await sql.execute(
      "INSERT INTO AUTH_SESSIONS (TOKEN_HASH,USER_ID,WORKSPACE_ID,CREATED_AT,EXPIRES_AT) VALUES (?,?,?,?,?)",
      [
        oauthDigest(session),
        owner.userId,
        owner.workspaceId,
        now,
        sqlTimestamp(new Date(Date.now() + 3600_000).toISOString()),
      ],
    );
  });
});
afterEach(async () => {
  try {
    await writeDatabase(async (sql) => {
      for (const table of [
        "CONVERSATION_TURNS",
        "TOOL_GENERATIONS",
        "TOOL_EVENTS",
        "TOOL_REVISIONS",
        "TOOL_DRAFTS",
        "TOOLS",
        "AGENT_EVENTS",
        "AGENT_RUNS",
        "COMMAND_RECEIPTS",
        "WORKSPACE_SETTINGS",
        "OPENAI_OAUTH_TRANSACTIONS",
        "OPENAI_CONNECTIONS",
        "AUTH_SESSIONS",
        "MEMBERSHIPS",
      ])
        await sql.execute(`DELETE FROM ${table} WHERE WORKSPACE_ID=?`, [
          owner.workspaceId,
        ]);
      await sql.execute("DELETE FROM WORKSPACES WHERE ID=?", [
        owner.workspaceId,
      ]);
      for (const actor of actors)
        await sql.execute("DELETE FROM AUTH_USERS WHERE ID=?", [actor.userId]);
    });
  } finally {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  }
});

async function consumed() {
  const started = await startOpenAiConnection(owner, session);
  return takeOpenAiTransaction(started.browserToken);
}
async function connect(expired = false) {
  const pending = await consumed();
  await saveOpenAiIdentity(
    owner,
    pending.sessionHash,
    identity(),
    tokens(expired),
    pending.browserHash,
  );
  return (await readDatabase((sql) => readOpenAiPlanStatus(sql, owner)))!;
}
async function row() {
  return (
    await readDatabase((sql) =>
      sql.query(
        "SELECT * FROM OPENAI_CONNECTIONS WHERE WORKSPACE_ID=? AND USER_ID=? AND HOST_ID=? AND CLIENT_ID=?",
        [owner.workspaceId, owner.userId, hostId, clientId],
      ),
    )
  )[0];
}
async function preferCodex() {
  await writeDatabase((sql) =>
    sql.execute(
      "INSERT INTO WORKSPACE_SETTINGS (WORKSPACE_ID,VERSION,SETTINGS_JSON,UPDATED_BY,UPDATED_AT) VALUES (?,0,?,?,?)",
      [
        owner.workspaceId,
        JSON.stringify({
          ...defaultWorkspaceSettings,
          preferredAgent: "codex",
        }),
        owner.userId,
        sqlTimestamp(new Date().toISOString()),
      ],
    ),
  );
}
function answer(reply: string) {
  return {
    decision: { reply, evidenceIds: [], toolInstructions: null, proposals: [] },
    inference: {
      requestedModel: "openai-chatgpt:synthetic-model@1",
      actualModel: "synthetic-model",
      generationId: "synthetic-generation",
      promptVersion: "conversation-v1",
      promptTokens: 1,
      completionTokens: 1,
      durationMs: 1,
      cost: null,
    },
  };
}

it("uses real SQL to consume a concurrent callback once and saves only one grant", async () => {
  const started = await startOpenAiConnection(owner, session);
  const authorize = new URL(started.authorizationUrl);
  const callback = new URL(
    `http://127.0.0.1:3000/api/oauth/openai/callback?code=synthetic&state=${authorize.searchParams.get("state")}&client_id=${clientId}`,
  );
  const outcomes = await Promise.allSettled([
    completeOpenAiConnection(callback, started.browserToken),
    completeOpenAiConnection(callback, started.browserToken),
  ]);
  expect(
    outcomes.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  const failure = outcomes.find((result) => result.status === "rejected");
  expect(failure).toMatchObject({ reason: { code: "OPENAI_OAUTH_FAILED" } });
  expect(boundary.exchange).toHaveBeenCalledTimes(1);
  await expect(
    takeOpenAiTransaction(started.browserToken),
  ).rejects.toMatchObject({ code: "OPENAI_OAUTH_FAILED" });
  expect((await row()).ACTIVE).toBe(true);
  expect(String((await row()).CREDENTIALS)).not.toContain(
    "synthetic-access-token",
  );
});

it("disconnect and a newer start each invalidate a consumed callback before its late save", async () => {
  const first = await consumed();
  await disconnectOpenAiIdentity(owner);
  await expect(
    saveOpenAiIdentity(
      owner,
      first.sessionHash,
      identity(),
      tokens(),
      first.browserHash,
    ),
  ).rejects.toMatchObject({ code: "OPENAI_CONNECTION_CHANGED" });
  const second = await consumed();
  const replacement = await startOpenAiConnection(owner, session);
  await expect(
    saveOpenAiIdentity(
      owner,
      second.sessionHash,
      identity(),
      tokens(),
      second.browserHash,
    ),
  ).rejects.toMatchObject({ code: "OPENAI_CONNECTION_CHANGED" });
  const current = await takeOpenAiTransaction(replacement.browserToken);
  await saveOpenAiIdentity(
    owner,
    current.sessionHash,
    identity(),
    tokens(),
    current.browserHash,
  );
  expect((await row()).ACTIVE).toBe(true);
});

it("rechecks owner authority and the original live session before saving tokens", async () => {
  const first = await consumed();
  await writeDatabase((sql) =>
    sql.execute("UPDATE AUTH_SESSIONS SET EXPIRES_AT=? WHERE TOKEN_HASH=?", [
      sqlTimestamp(new Date(0).toISOString()),
      oauthDigest(session),
    ]),
  );
  await expect(
    saveOpenAiIdentity(
      owner,
      first.sessionHash,
      identity(),
      tokens(),
      first.browserHash,
    ),
  ).rejects.toMatchObject({ code: "OPENAI_OAUTH_SESSION_CHANGED" });
  await writeDatabase(async (sql) => {
    await sql.execute(
      "UPDATE AUTH_SESSIONS SET EXPIRES_AT=? WHERE TOKEN_HASH=?",
      [
        sqlTimestamp(new Date(Date.now() + 3600_000).toISOString()),
        oauthDigest(session),
      ],
    );
    await sql.execute(
      "UPDATE MEMBERSHIPS SET \"ROLE\"='operator' WHERE WORKSPACE_ID=? AND USER_ID=?",
      [owner.workspaceId, owner.userId],
    );
  });
  await expect(
    saveOpenAiIdentity(
      owner,
      first.sessionHash,
      identity(),
      tokens(),
      first.browserHash,
    ),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  expect(await row()).toBeUndefined();
});

it("keeps credentials private and grants scoped to the owner while model/disconnect changes invalidate reservations", async () => {
  const grant = await connect();
  const status = await readOpenAiConnection(owner);
  expect(status).toMatchObject({
    status: "plan_enabled",
    model: "synthetic-model",
    inferenceAvailable: true,
  });
  expect(JSON.stringify(status)).not.toMatch(
    /synthetic-access-token|synthetic-refresh-token|synthetic-id-token|CREDENTIALS/,
  );
  expect(await getOpenAiPlanCredential(anotherOwner)).toBeNull();
  expect(await getOpenAiPlanCredential(operator)).toBeNull();
  await expect(
    readDatabase((sql) => assertOpenAiPlanCurrent(sql, owner, grant)),
  ).resolves.toBeUndefined();
  await updateOpenAiModel(owner, "changed-model");
  await expect(
    readDatabase((sql) => assertOpenAiPlanCurrent(sql, owner, grant)),
  ).rejects.toMatchObject({ code: "OPENAI_CONNECTION_CHANGED" });
  const updated = (await readDatabase((sql) =>
    readOpenAiPlanStatus(sql, owner),
  ))!;
  expect(updated.revision).toBe(grant.revision + 1);
  await disconnectOpenAiIdentity(owner);
  await expect(
    readDatabase((sql) => assertOpenAiPlanCurrent(sql, owner, updated)),
  ).rejects.toMatchObject({ code: "OPENAI_CONNECTION_CHANGED" });
  expect((await row()).CREDENTIALS).toBeNull();
  expect(boundary.revoke).toHaveBeenCalledTimes(1);
});

it("serializes refresh-token rotation and releases the committed SQL lease without changing grant revision", async () => {
  const grant = await connect(true);
  let release!: (value: OpenAiTokens) => void;
  boundary.refresh.mockImplementation(
    () =>
      new Promise<OpenAiTokens>((resolve) => {
        release = resolve;
      }),
  );
  const outcomes = Promise.allSettled([
    getOpenAiPlanCredential(owner),
    getOpenAiPlanCredential(owner),
  ]);
  await vi.waitFor(() => expect(boundary.refresh).toHaveBeenCalledTimes(1));
  expect((await row()).REFRESH_OWNER).not.toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 350));
  expect(boundary.refresh).toHaveBeenCalledTimes(1);
  release({
    ...tokens(),
    accessToken: "rotated-synthetic-access",
    refreshToken: "rotated-synthetic-refresh",
  });
  const results = await outcomes;
  for (const result of results)
    expect(result).toMatchObject({
      status: "fulfilled",
      value: {
        accessToken: "rotated-synthetic-access",
        revision: grant.revision,
      },
    });
  expect(boundary.refresh).toHaveBeenCalledTimes(1);
  expect(await row()).toMatchObject({
    REFRESH_OWNER: null,
    REFRESH_UNTIL: null,
    AUTH_VERSION: grant.revision,
  });
});

it("releases failed refresh leases and clears terminally invalid credentials", async () => {
  const grant = await connect(true);
  boundary.refresh.mockRejectedValueOnce(
    new DomainError("MODEL_HTTP_503", "Synthetic temporary failure", 503),
  );
  await expect(getOpenAiPlanCredential(owner)).rejects.toMatchObject({
    code: "MODEL_HTTP_503",
  });
  expect(await row()).toMatchObject({
    REFRESH_OWNER: null,
    REFRESH_UNTIL: null,
    AUTH_VERSION: grant.revision,
  });
  expect((await row()).CREDENTIALS).not.toBeNull();
  boundary.refresh.mockRejectedValueOnce(
    new DomainError(
      "OPENAI_RECONNECT_REQUIRED",
      "Synthetic revoked credential",
      401,
    ),
  );
  await expect(getOpenAiPlanCredential(owner)).rejects.toMatchObject({
    code: "OPENAI_RECONNECT_REQUIRED",
  });
  expect(await row()).toMatchObject({
    REFRESH_OWNER: null,
    REFRESH_UNTIL: null,
    CREDENTIALS: null,
    AUTH_VERSION: grant.revision + 1,
  });
  expect(await getOpenAiPlanCredential(owner)).toBeNull();
});

it("does not save a refresh after the model grant changes, and does not disconnect during active rotation", async () => {
  await connect(true);
  let release!: (value: OpenAiTokens) => void;
  boundary.refresh.mockImplementation(
    () =>
      new Promise<OpenAiTokens>((resolve) => {
        release = resolve;
      }),
  );
  const outcome = getOpenAiPlanCredential(owner).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await vi.waitFor(() => expect(boundary.refresh).toHaveBeenCalledTimes(1));
  await expect(disconnectOpenAiIdentity(owner)).rejects.toMatchObject({
    code: "OPENAI_REFRESH_UNAVAILABLE",
  });
  await updateOpenAiModel(owner, "changed-during-refresh");
  release({ ...tokens(), accessToken: "late-refresh-result" });
  expect(await outcome).toMatchObject({
    error: { code: "OPENAI_CONNECTION_CHANGED" },
  });
  expect(await row()).toMatchObject({
    MODEL: "changed-during-refresh",
    REFRESH_OWNER: null,
    REFRESH_UNTIL: null,
  });
  expect(String((await row()).CREDENTIALS)).not.toContain(
    "late-refresh-result",
  );
});

it("selects only an owner's own personal plan, with no global-provider fallback for colleagues", async () => {
  await connect();
  await preferCodex();
  vi.stubEnv("OPENROUTER_API_KEY", "synthetic-global-key-must-not-be-used");
  vi.stubEnv("OPENROUTER_MODEL", "fixture:free");
  const configured = await readDatabase((sql) =>
    conversationConfiguration(sql, owner),
  );
  expect(configured).toMatchObject({
    configured: true,
    mode: "builtin",
    provider: "codex",
    model: "openai-chatgpt:synthetic-model@1",
  });
  for (const actor of [anotherOwner, operator])
    expect(
      await readDatabase((sql) => conversationConfiguration(sql, actor)),
    ).toMatchObject({
      configured: false,
      mode: "unavailable",
      provider: "codex",
      model: null,
    });
  expect(boundary.infer).not.toHaveBeenCalled();
});

it("passes the personal token to inference and discards a late answer after disconnect", async () => {
  await connect();
  await preferCodex();
  boundary.infer.mockResolvedValue(answer("A verified synthetic reply"));
  const completed = await sendConversation(owner, {
    commandId: randomUUID(),
    prompt: "Explain the empty analytics queue.",
  });
  expect(boundary.infer.mock.calls[0][3]).toMatchObject({
    provider: "openai-chatgpt",
    model: "synthetic-model",
    key: "synthetic-access-token",
    revision: 1,
  });
  expect(
    completed.messages.some(
      (message) =>
        message.content === "A verified synthetic reply" &&
        message.state === "complete",
    ),
  ).toBe(true);
  let release!: (value: ReturnType<typeof answer>) => void;
  boundary.infer.mockReset().mockImplementation(
    () =>
      new Promise<ReturnType<typeof answer>>((resolve) => {
        release = resolve;
      }),
  );
  const commandId = randomUUID();
  const pending = sendConversation(owner, {
    commandId,
    prompt: "Wait for this synthetic answer.",
  });
  await vi.waitFor(() => expect(boundary.infer).toHaveBeenCalledTimes(1));
  await disconnectOpenAiIdentity(owner);
  release(answer("This late reply must not be saved"));
  const result = await pending;
  expect(
    result.messages.some(
      (message) => message.content === "This late reply must not be saved",
    ),
  ).toBe(false);
  const [saved] = await readDatabase((sql) =>
    sql.query(
      'SELECT "STATE",RESULT_JSON FROM CONVERSATION_TURNS WHERE WORKSPACE_ID=? AND COMMAND_ID=?',
      [owner.workspaceId, commandId],
    ),
  );
  expect(saved.STATE).toBe("failed");
  expect(JSON.parse(String(saved.RESULT_JSON))).toMatchObject({
    error: "OPENAI_CONNECTION_CHANGED",
    proposalIds: [],
  });
  const [proposals] = await readDatabase((sql) =>
    sql.query(
      "SELECT COUNT(*) AS TOTAL FROM TRIAGE_PROPOSALS WHERE WORKSPACE_ID=?",
      [owner.workspaceId],
    ),
  );
  expect(Number(proposals.TOTAL)).toBe(0);
});

it("uses the owner's plan in the direct tool designer and never offers it to colleagues", async () => {
  await connect();
  await preferCodex();
  vi.stubEnv("OPENROUTER_API_KEY", "synthetic-global-key-must-not-be-used");
  vi.stubEnv("OPENROUTER_MODEL", "fixture:free");
  const workspace = await toolWorkspace(owner);
  expect(workspace.configuration).toMatchObject({
    configured: true,
    model: "openai-chatgpt:synthetic-model@1",
    freeOnly: false,
  });
  for (const actor of [anotherOwner, operator])
    expect((await toolWorkspace(actor)).configuration).toMatchObject({
      configured: false,
      model: null,
    });
  const generation = {
    spec: { ...workspace.published.spec, title: "Analytics intake" },
    assumptions: [],
    unsupported: [],
    inference: answer("").inference,
  };
  boundary.design.mockResolvedValue(generation);
  const draft = await generateToolDraft(
    owner,
    randomUUID(),
    workspace.published.revision,
    "Name this tool Analytics intake and preserve its fields.",
    workspace.published.spec,
  );
  expect(boundary.design).toHaveBeenCalledTimes(1);
  expect(boundary.design.mock.calls[0][3]).toMatchObject({
    provider: "openai-chatgpt",
    model: "synthetic-model",
    key: "synthetic-access-token",
    revision: 1,
  });
  expect(draft.spec).toEqual(generation.spec);
  expect((await toolWorkspace(owner)).drafts.map(({ id }) => id)).toContain(
    draft.id,
  );
  await expect(
    generateToolDraft(
      anotherOwner,
      randomUUID(),
      workspace.published.revision,
      "Generate without inheriting another owner's account.",
      workspace.published.spec,
    ),
  ).rejects.toMatchObject({ code: "OPENAI_PLAN_NOT_AUTHORIZED" });
  expect(boundary.design).toHaveBeenCalledTimes(1);
  expect(fetch).not.toHaveBeenCalled();
});

it("discards a direct designer result when the personal grant is disconnected during generation", async () => {
  await connect();
  await preferCodex();
  const { published } = await toolWorkspace(owner);
  const generation = {
    spec: { ...published.spec, title: "Late draft must not be saved" },
    assumptions: [],
    unsupported: [],
    inference: answer("").inference,
  };
  let release!: (value: typeof generation) => void;
  boundary.design.mockImplementation(
    () =>
      new Promise<typeof generation>((resolve) => {
        release = resolve;
      }),
  );
  const commandId = randomUUID();
  const outcome = generateToolDraft(
    owner,
    commandId,
    published.revision,
    "Generate a draft after waiting for this synthetic response.",
    published.spec,
  ).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await vi.waitFor(() => expect(boundary.design).toHaveBeenCalledTimes(1));
  await disconnectOpenAiIdentity(owner);
  release(generation);
  expect(await outcome).toMatchObject({
    error: { code: "OPENAI_CONNECTION_CHANGED" },
  });
  expect((await toolWorkspace(owner)).drafts).toEqual([]);
  const [attempt] = await readDatabase((sql) =>
    sql.query(
      "SELECT LIFECYCLE,DRAFT_ID FROM TOOL_GENERATIONS WHERE WORKSPACE_ID=? AND COMMAND_ID=?",
      [owner.workspaceId, commandId],
    ),
  );
  expect(attempt).toMatchObject({ LIFECYCLE: "failed", DRAFT_ID: null });
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects advanced triage in personal-plan mode before using an API provider or saving a run", async () => {
  await connect();
  await preferCodex();
  vi.stubEnv("OPENROUTER_API_KEY", "synthetic-global-key-must-not-be-used");
  vi.stubEnv("OPENROUTER_MODEL", "fixture:free");
  await expect(
    startRun(
      owner,
      randomUUID(),
      [randomUUID()],
      "Review the analytics queue.",
    ),
  ).rejects.toMatchObject({ code: "PERSONAL_PLAN_REQUIRED" });
  const [runs] = await readDatabase((sql) =>
    sql.query("SELECT COUNT(*) AS TOTAL FROM AGENT_RUNS WHERE WORKSPACE_ID=?", [
      owner.workspaceId,
    ]),
  );
  expect(Number(runs.TOTAL)).toBe(0);
  expect(boundary.triage).not.toHaveBeenCalled();
  expect(boundary.infer).not.toHaveBeenCalled();
  expect(boundary.design).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
