import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { Actor, ProviderSettingsInput } from "@loom/contracts";
import { readDatabase, writeDatabase } from "@loom/db-exasol";
import {
  readProviderSettings,
  updateProviderSettings,
  workspaceProvider,
  assertProviderCurrent,
} from "../../apps/web/server/provider-config";
import { sendConversation } from "../../apps/web/server/conversation";
const owner: Actor = { workspaceId: randomUUID(), userId: randomUUID() };
const requester: Actor = {
  workspaceId: owner.workspaceId,
  userId: randomUUID(),
};
const other: Actor = { workspaceId: randomUUID(), userId: randomUUID() };
const key = "public-fixture-key-not-a-real-provider-key";
beforeAll(async () => {
  vi.stubEnv("LOOM_PROVIDER_ENCRYPTION_KEY", "34".repeat(32));
  await writeDatabase(async (sql) => {
    for (const actor of [owner, other])
      await sql.execute("INSERT INTO WORKSPACES (ID,NAME) VALUES (?,?)", [
        actor.workspaceId,
        "Provider integration fixture",
      ]);
    for (const actor of [owner, requester, other])
      await sql.execute(
        "INSERT INTO MEMBERSHIPS (WORKSPACE_ID,USER_ID,NAME,ROLE,ACTIVE,VERSION) VALUES (?,?,?,?,TRUE,1)",
        [
          actor.workspaceId,
          actor.userId,
          "Provider fixture",
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
      "CONVERSATION_TURNS",
      "AGENT_EVENTS",
      "PROVIDER_TEST_ATTEMPTS",
      "PROVIDER_CONNECTIONS",
      "WORKSPACE_EVENTS",
      "COMMAND_RECEIPTS",
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
function input(): ProviderSettingsInput {
  return {
    action: "test-and-save",
    commandId: randomUUID(),
    expectedVersion: 0,
    provider: "deepseek",
    model: "fixture-model",
    apiKey: key,
    maxTokens: 2048,
    acknowledgeCharges: true,
  };
}
function valid() {
  return Response.json({
    id: "fixture",
    model: "fixture-model",
    choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }],
  });
}
it("enforces owner-only connection tests before any inference", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(readProviderSettings(requester)).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  await expect(
    updateProviderSettings(requester, input()),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  expect(fetch).not.toHaveBeenCalled();
});
it("saves encrypted company credentials, scopes them, replays without inference, and rejects revoked configurations", async () => {
  const fetch = vi.fn().mockImplementation(async () => valid());
  vi.stubGlobal("fetch", fetch);
  const values = input(),
    saved = await updateProviderSettings(owner, values);
  expect(saved).toMatchObject({
    active: true,
    version: 1,
    provider: "deepseek",
    model: "fixture-model",
  });
  expect(JSON.stringify(saved)).not.toContain(key);
  const [row] = await readDatabase((sql) =>
    sql.query(
      "SELECT CREDENTIAL FROM PROVIDER_CONNECTIONS WHERE WORKSPACE_ID=?",
      [owner.workspaceId],
    ),
  );
  expect(row.CREDENTIAL).not.toContain(key);
  const runtime = await readDatabase((sql) => workspaceProvider(sql, owner));
  expect(runtime?.key).toBe(key);
  expect(await readDatabase((sql) => workspaceProvider(sql, other))).toBeNull();
  expect(await updateProviderSettings(owner, values)).toEqual(saved);
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockImplementation(async () =>
    Response.json({
      id: "provider-conversation-fixture",
      model: "fixture-model",
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              reply: "Your analytics workspace is ready.",
              evidenceIds: [],
              toolInstructions: null,
              proposals: [],
            }),
          },
        },
      ],
    }),
  );
  const conversation = await sendConversation(owner, {
    commandId: randomUUID(),
    prompt: "Explain my analytics workspace.",
  });
  expect(conversation.configuration.model).toBe("deepseek:fixture-model@1");
  expect(
    conversation.messages.some(
      (message) => message.content === "Your analytics workspace is ready.",
    ),
  ).toBe(true);
  expect(fetch.mock.lastCall?.[0]).toBe(
    "https://api.deepseek.com/chat/completions",
  );
  expect(JSON.stringify(conversation)).not.toContain(key);
  await expect(updateProviderSettings(owner, input())).rejects.toMatchObject({
    code: "VERSION_CONFLICT",
  });
  const revoked = await updateProviderSettings(owner, {
    action: "revoke",
    commandId: randomUUID(),
    expectedVersion: 1,
  });
  expect(revoked).toMatchObject({ active: false, version: 2 });
  await expect(
    readDatabase((sql) => workspaceProvider(sql, owner)),
  ).rejects.toMatchObject({ code: "PROVIDER_DISCONNECTED" });
  await expect(
    readDatabase((sql) => assertProviderCurrent(sql, owner, runtime)),
  ).rejects.toMatchObject({ code: "MODEL_CONFIGURATION_CHANGED" });
  const [removed] = await readDatabase((sql) =>
    sql.query(
      "SELECT CREDENTIAL FROM PROVIDER_CONNECTIONS WHERE WORKSPACE_ID=?",
      [owner.workspaceId],
    ),
  );
  expect(removed.CREDENTIAL).toBeNull();
});
it("does not save failed tests and never returns upstream secret-bearing messages", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json({ error: { message: key, code: 401 } }, { status: 401 }),
    );
  vi.stubGlobal("fetch", fetch);
  const values = input();
  await expect(updateProviderSettings(other, values)).rejects.toMatchObject({
    code: "MODEL_HTTP_401",
  });
  expect((await readProviderSettings(other)).active).toBe(false);
  await expect(updateProviderSettings(other, values)).rejects.toMatchObject({
    code: "PROVIDER_TEST_USED",
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});
