import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { z } from "zod";
import {
  companyProviders,
  providerSettingsInputSchema,
  providerModelsInputSchema,
  type Actor,
  type ProviderSettingsInput,
  type ProviderSettingsSnapshot,
} from "@loom/contracts";
import { DomainError } from "@loom/domain";
import {
  fromTimestamp,
  readDatabase,
  writeDatabase,
  sqlTimestamp,
  type Row,
  type SqlSession,
} from "@loom/db-exasol";
import { membership, digest, receipt } from "./desk";
import { saveReceipt } from "./knowledge";
import {
  boundedProviderBody,
  modelIdentity,
  providerFetch,
  type ProviderRuntimeConfig,
} from "./provider-transport";
import { modelResponseError } from "./model-errors";
import { settingsFor } from "./settings";
import { fetchModelCatalog } from "./model-catalog";
import { limitCredentialAttempt } from "./auth-limits";

function encryptionKey() {
  const value = process.env.LOOM_PROVIDER_ENCRYPTION_KEY;
  if (!value || !/^[a-fA-F0-9]{64}$/.test(value))
    throw new DomainError(
      "PROVIDER_STORAGE_UNAVAILABLE",
      "Company AI connections need a deployment encryption key. Ask the server administrator to configure LOOM_PROVIDER_ENCRYPTION_KEY.",
      503,
    );
  return Buffer.from(value, "hex");
}
export function encryptProviderCredential(
  secret: string,
  associatedData: string,
) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(associatedData));
  const encrypted = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}
export function decryptProviderCredential(
  value: string,
  associatedData: string,
) {
  const key = encryptionKey();
  try {
    const [version, iv, tag, ciphertext, extra] = value.split(".");
    if (version !== "v1" || extra !== undefined || !iv || !tag || !ciphertext)
      throw new Error();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "base64url"),
    );
    decipher.setAAD(Buffer.from(associatedData));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new DomainError(
      "PROVIDER_CREDENTIAL_UNAVAILABLE",
      "The saved company credential could not be unlocked. An owner must reconnect the provider.",
      503,
    );
  }
}
async function owner(sql: SqlSession, actor: Actor) {
  const member = await membership(sql, actor);
  if (member.role !== "owner")
    throw new DomainError(
      "ACCESS_DENIED",
      "Only company owners can manage the AI provider.",
      403,
    );
}
async function connectionRow(sql: SqlSession, actor: Actor) {
  const [row] = await sql.query(
    "SELECT * FROM PROVIDER_CONNECTIONS WHERE WORKSPACE_ID=?",
    [actor.workspaceId],
  );
  return row;
}
function associated(
  workspaceId: string,
  version: number,
  provider: string,
  model: string,
) {
  return JSON.stringify({ workspaceId, version, provider, model });
}
function snapshot(row?: Row): ProviderSettingsSnapshot {
  let available = true,
    message = "";
  try {
    encryptionKey();
  } catch (error) {
    available = false;
    message = (error as Error).message;
  }
  return {
    available,
    message,
    version: row ? Number(row.VERSION) : 0,
    active: row?.ACTIVE === true,
    provider: row ? z.enum(companyProviders).parse(row.PROVIDER) : null,
    model: row ? String(row.MODEL) : null,
    maxTokens: row ? Number(row.MAX_TOKENS) : 4096,
    testedAt: row ? fromTimestamp(row.TESTED_AT) : null,
    updatedAt: row ? fromTimestamp(row.UPDATED_AT) : null,
  };
}
export async function readProviderSettings(actor: Actor) {
  return readDatabase(async (sql) => {
    await owner(sql, actor);
    return snapshot(await connectionRow(sql, actor));
  });
}
export async function listCompanyModels(
  actor: Actor,
  input: z.infer<typeof providerModelsInputSchema>,
) {
  const values = providerModelsInputSchema.parse(input);
  const credential = await readDatabase(async (sql) => {
    await owner(sql, actor);
    if (values.apiKey) return { key: values.apiKey, version: null };
    const row = await connectionRow(sql, actor);
    if (!row?.ACTIVE || row.PROVIDER !== values.provider || !row.CREDENTIAL)
      throw new DomainError(
        "PROVIDER_KEY_REQUIRED",
        "Enter your API key to load models.",
        400,
      );
    return {
      key: decryptProviderCredential(
        String(row.CREDENTIAL),
        associated(
          actor.workspaceId,
          Number(row.VERSION),
          values.provider,
          String(row.MODEL),
        ),
      ),
      version: Number(row.VERSION),
    };
  });
  limitCredentialAttempt(`models:${actor.workspaceId}:${actor.userId}`);
  const models = await fetchModelCatalog(values.provider, credential.key);
  await readDatabase(async (sql) => {
    await owner(sql, actor);
    if (credential.version !== null) {
      const row = await connectionRow(sql, actor);
      if (!row?.ACTIVE || Number(row.VERSION) !== credential.version)
        throw new DomainError(
          "WORKSPACE_CHANGED",
          "Your connection changed. Reload its models.",
          409,
        );
    }
  });
  return { models };
}
// Call only inside an already-authorized workspace transaction. Secrets remain server-side.
export async function workspaceProvider(
  sql: SqlSession,
  actor: Actor,
): Promise<ProviderRuntimeConfig | null> {
  if ((await settingsFor(sql, actor)).preferredAgent === "codex")
    throw new DomainError(
      "PERSONAL_PLAN_REQUIRED",
      "Codex is selected. Use the assistant or tool designer with your ChatGPT connection. Choose Company AI explicitly to run advanced triage with an API account.",
      409,
    );
  const row = await connectionRow(sql, actor);
  if (!row) return null;
  if (row.ACTIVE !== true || !row.CREDENTIAL)
    throw new DomainError(
      "PROVIDER_DISCONNECTED",
      "The company AI provider is disconnected. Ask an owner to reconnect it in Company AI.",
      503,
    );
  const provider = z.enum(companyProviders).parse(row.PROVIDER),
    revision = Number(row.VERSION),
    model = String(row.MODEL);
  return {
    provider,
    revision,
    model,
    key: decryptProviderCredential(
      String(row.CREDENTIAL),
      associated(actor.workspaceId, revision, provider, model),
    ),
    maxTokens: Number(row.MAX_TOKENS),
    timeoutMs: 60_000,
    freeOnly: false,
  };
}
export async function assertProviderCurrent(
  sql: SqlSession,
  actor: Actor,
  config?: ProviderRuntimeConfig | null,
) {
  if (!config?.revision) return;
  const row = await connectionRow(sql, actor);
  if (
    !row ||
    row.ACTIVE !== true ||
    Number(row.VERSION) !== config.revision ||
    row.PROVIDER !== config.provider ||
    row.MODEL !== config.model
  )
    throw new DomainError(
      "MODEL_CONFIGURATION_CHANGED",
      "The company AI connection changed during this request. No generated changes were saved; send a new request.",
      409,
    );
}
async function event(
  sql: SqlSession,
  actor: Actor,
  kind: string,
  version: number,
) {
  await sql.execute(
    "INSERT INTO WORKSPACE_EVENTS (WORKSPACE_ID,ID,ACTOR_ID,ACTION_KIND,SUBJECT_ID,VERSION,CREATED_AT) VALUES (?,?,?,?,?,?,?)",
    [
      actor.workspaceId,
      randomUUID(),
      actor.userId,
      kind,
      actor.workspaceId,
      version,
      sqlTimestamp(new Date().toISOString()),
    ],
  );
}
export async function updateProviderSettings(
  actor: Actor,
  input: ProviderSettingsInput,
): Promise<ProviderSettingsSnapshot> {
  const values = providerSettingsInputSchema.parse(input),
    hash = digest({ type: "company-provider", ...values });
  if (values.action === "revoke")
    return writeDatabase(async (sql) => {
      await owner(sql, actor);
      if (await receipt(sql, actor, values.commandId, hash))
        return snapshot(await connectionRow(sql, actor));
      const current = await connectionRow(sql, actor);
      if (!current || Number(current.VERSION) !== values.expectedVersion)
        throw new DomainError(
          "VERSION_CONFLICT",
          "Company AI settings changed. Reload before disconnecting.",
          409,
        );
      await sql.execute(
        "UPDATE PROVIDER_CONNECTIONS SET ACTIVE=FALSE,CREDENTIAL=NULL,VERSION=VERSION+1,UPDATED_AT=?,UPDATED_BY=? WHERE WORKSPACE_ID=? AND VERSION=?",
        [
          sqlTimestamp(new Date().toISOString()),
          actor.userId,
          actor.workspaceId,
          values.expectedVersion,
        ],
      );
      await event(
        sql,
        actor,
        "provider_disconnected",
        values.expectedVersion + 1,
      );
      await saveReceipt(sql, actor, values.commandId, hash, {
        disconnected: true,
      });
      return snapshot(await connectionRow(sql, actor));
    });
  encryptionKey();
  const cached = await writeDatabase(async (sql) => {
    await owner(sql, actor);
    if (await receipt(sql, actor, values.commandId, hash))
      return snapshot(await connectionRow(sql, actor));
    const current = await connectionRow(sql, actor);
    if (Number(current?.VERSION || 0) !== values.expectedVersion)
      throw new DomainError(
        "VERSION_CONFLICT",
        "Company AI settings changed. Reload before testing a new connection.",
        409,
      );
    const [attempt] = await sql.query(
      "SELECT COMMAND_ID FROM PROVIDER_TEST_ATTEMPTS WHERE WORKSPACE_ID=? AND COMMAND_ID=?",
      [actor.workspaceId, values.commandId],
    );
    if (attempt)
      throw new DomainError(
        "PROVIDER_TEST_USED",
        "This connection test already started. Reload to check the result, or deliberately start a new test.",
        409,
      );
    const [recent] = await sql.query(
      "SELECT COMMAND_ID FROM PROVIDER_TEST_ATTEMPTS WHERE WORKSPACE_ID=? AND CREATED_AT>? LIMIT 1",
      [
        actor.workspaceId,
        sqlTimestamp(new Date(Date.now() - 30_000).toISOString()),
      ],
    );
    if (recent)
      throw new DomainError(
        "PROVIDER_TEST_COOLDOWN",
        "Wait 30 seconds before another company connection test.",
        429,
        { retryAfterSeconds: 30 },
      );
    await sql.execute(
      "INSERT INTO PROVIDER_TEST_ATTEMPTS (WORKSPACE_ID,COMMAND_ID,ACTOR_ID,PAYLOAD_HASH,LIFECYCLE,CREATED_AT) VALUES (?,?,?,?,'running',?)",
      [
        actor.workspaceId,
        values.commandId,
        actor.userId,
        hash,
        sqlTimestamp(new Date().toISOString()),
      ],
    );
    return null;
  });
  if (cached) return cached;
  try {
    const response = await providerFetch(
      {
        provider: values.provider,
        model: values.model,
        key: values.apiKey,
        maxTokens: 256,
        timeoutMs: 30_000,
        freeOnly: false,
      },
      {
        system:
          'Return the JSON object {"ok":true}. This is a connection test containing no company data.',
        input: "Confirm the connection.",
        schemaName: "loom_connection_test",
        schema: {
          type: "object",
          properties: { ok: { type: "boolean", const: true } },
          required: ["ok"],
          additionalProperties: false,
        },
      },
    );
    let body: unknown;
    try {
      body = await boundedProviderBody(response);
    } catch {
      throw (
        modelResponseError(response, {}) ||
        new DomainError(
          "MODEL_RESPONSE",
          "The provider returned an unreadable connection-test response.",
          502,
        )
      );
    }
    const failure = modelResponseError(response, body);
    if (failure) throw failure;
    const result = z
      .object({
        choices: z
          .array(
            z.object({
              finish_reason: z.literal("stop"),
              message: z.object({
                content: z.string(),
                refusal: z.string().nullish(),
              }),
            }),
          )
          .min(1),
      })
      .parse(body);
    if (result.choices[0].message.refusal) throw new Error();
    z.object({ ok: z.literal(true) })
      .strict()
      .parse(JSON.parse(result.choices[0].message.content));
    return await writeDatabase(async (sql) => {
      await owner(sql, actor);
      const current = await connectionRow(sql, actor);
      if (Number(current?.VERSION || 0) !== values.expectedVersion)
        throw new DomainError(
          "VERSION_CONFLICT",
          "The connection tested successfully, but company settings changed. Reload before reconnecting.",
          409,
        );
      const version = values.expectedVersion + 1,
        now = sqlTimestamp(new Date().toISOString());
      const credential = encryptProviderCredential(
        values.apiKey,
        associated(actor.workspaceId, version, values.provider, values.model),
      );
      if (current)
        await sql.execute(
          "UPDATE PROVIDER_CONNECTIONS SET VERSION=?,PROVIDER=?,MODEL=?,MAX_TOKENS=?,ACTIVE=TRUE,CREDENTIAL=?,TESTED_AT=?,UPDATED_AT=?,UPDATED_BY=? WHERE WORKSPACE_ID=? AND VERSION=?",
          [
            version,
            values.provider,
            values.model,
            values.maxTokens,
            credential,
            now,
            now,
            actor.userId,
            actor.workspaceId,
            values.expectedVersion,
          ],
        );
      else
        await sql.execute(
          "INSERT INTO PROVIDER_CONNECTIONS (WORKSPACE_ID,VERSION,PROVIDER,MODEL,MAX_TOKENS,ACTIVE,CREDENTIAL,TESTED_AT,UPDATED_AT,UPDATED_BY) VALUES (?,?,?,?,?,TRUE,?,?,?,?)",
          [
            actor.workspaceId,
            version,
            values.provider,
            values.model,
            values.maxTokens,
            credential,
            now,
            now,
            actor.userId,
          ],
        );
      await sql.execute(
        "UPDATE PROVIDER_TEST_ATTEMPTS SET LIFECYCLE='complete' WHERE WORKSPACE_ID=? AND COMMAND_ID=?",
        [actor.workspaceId, values.commandId],
      );
      await event(sql, actor, "provider_connected", version);
      await saveReceipt(sql, actor, values.commandId, hash, {
        version,
        model: modelIdentity({
          provider: values.provider,
          model: values.model,
          revision: version,
          key: "",
          maxTokens: values.maxTokens,
          timeoutMs: 60_000,
          freeOnly: false,
        }),
      });
      return snapshot(await connectionRow(sql, actor));
    });
  } catch (error) {
    await writeDatabase(async (sql) => {
      await sql.execute(
        "UPDATE PROVIDER_TEST_ATTEMPTS SET LIFECYCLE='failed' WHERE WORKSPACE_ID=? AND COMMAND_ID=? AND LIFECYCLE='running'",
        [actor.workspaceId, values.commandId],
      );
    }).catch(() => undefined);
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      "PROVIDER_TEST_FAILED",
      "The provider did not complete the structured connection test. Check the API key, model, and provider budget. Nothing was saved.",
      502,
    );
  }
}
