import "server-only";
import { randomUUID } from "node:crypto";
import {
  sourceSelectionSchema,
  type Actor,
  type ExternalSource,
  type Intake,
  type SourceProvider,
  type SourceSelection,
  type SourceSnapshot,
} from "@loom/contracts";
import { DomainError } from "@loom/domain";
import {
  fromTimestamp,
  readDatabase,
  writeDatabase,
  sqlTimestamp,
  isConfigured,
  type Row,
  type SqlSession,
} from "@loom/db-exasol";
import {
  assertRecordSize,
  digest,
  getRequest,
  insertRequest,
  recordChange,
} from "./desk";
import { retireDocument, storeDocument } from "./source-documents";
import {
  connectionRow,
  sourceOwner,
  sourceRuntime,
} from "./source-connections";
import {
  fetchSourcePage,
  sourceOptions,
  validateSource,
  type SourceConfig,
  type SourceCursor,
  type SourceItem,
} from "./source-adapters";
import { microsoftConfiguration, SourceError } from "./source-transport";

const date = (time = Date.now()) => sqlTimestamp(new Date(time).toISOString());
const kind = (provider: SourceProvider) =>
  provider === "slack" ? "slack" : "microsoft";
export async function sourceSnapshot(actor: Actor): Promise<SourceSnapshot> {
  return readDatabase(async (sql) => {
    await sourceOwner(sql, actor);
    const connections = await sql.query(
      "SELECT PROVIDER,DISPLAY_NAME,VERSION FROM SOURCE_CONNECTIONS WHERE WORKSPACE_ID=? AND ACTIVE=TRUE",
      [actor.workspaceId],
    );
    const sources = await sql.query(
      "SELECT S.*, (SELECT COUNT(*) FROM SOURCE_ITEMS I WHERE I.WORKSPACE_ID=S.WORKSPACE_ID AND I.SOURCE_ID=S.ID AND I.RESOURCE_ID IS NOT NULL AND I.RESOURCE_KIND IN ('request','knowledge')) AS IMPORTED_COUNT FROM CONNECTED_SOURCES S WHERE S.WORKSPACE_ID=? ORDER BY S.DISPLAY_NAME LIMIT 25",
      [actor.workspaceId],
    );
    const details = new Map<
      string,
      {
        reviewCount: number;
        review: SourceSnapshot["sources"][number]["review"];
        issues: SourceSnapshot["sources"][number]["issues"];
      }
    >();
    for (const source of sources) {
      const [count] = await sql.query(
        "SELECT COUNT(*) AS TOTAL FROM SOURCE_ITEMS WHERE WORKSPACE_ID=? AND SOURCE_ID=? AND RESOURCE_KIND='review'",
        [actor.workspaceId, source.ID],
      );
      const candidates = await sql.query(
        "SELECT EXTERNAL_ID,CONTENT_HASH,ITEM_JSON,DETAIL FROM SOURCE_ITEMS WHERE WORKSPACE_ID=? AND SOURCE_ID=? AND RESOURCE_KIND='review' ORDER BY EXTERNAL_ID LIMIT 10",
        [actor.workspaceId, source.ID],
      );
      const issues = await sql.query(
        "SELECT ITEM_JSON,DETAIL FROM SOURCE_ITEMS WHERE WORKSPACE_ID=? AND SOURCE_ID=? AND DETAIL IS NOT NULL AND RESOURCE_KIND IN ('knowledge','skipped') ORDER BY EXTERNAL_ID LIMIT 10",
        [actor.workspaceId, source.ID],
      );
      details.set(String(source.ID), {
        reviewCount: Number(count.TOTAL),
        review: candidates.map((row) => {
          const item = JSON.parse(String(row.ITEM_JSON)) as SourceItem;
          return {
            externalId: String(row.EXTERNAL_ID),
            hash: String(row.CONTENT_HASH),
            title: item.title,
            text: item.text,
            url: item.url,
            reason: String(row.DETAIL),
          };
        }),
        issues: issues.map((row) => ({
          title: JSON.parse(String(row.ITEM_JSON || "{}")).title || "Document",
          reason: String(row.DETAIL),
        })),
      });
    }
    let microsoftAvailable = false;
    try {
      microsoftConfiguration();
      microsoftAvailable = true;
    } catch {
      /* Setup remains local. */
    }
    return {
      microsoftAvailable,
      syncEnabled: process.env.LOOM_SOURCE_SYNC !== "false",
      connections: connections.map((row) => ({
        provider: row.PROVIDER as "slack" | "microsoft",
        name: String(row.DISPLAY_NAME),
        version: Number(row.VERSION),
      })),
      sources: sources.map((row) => ({
        id: String(row.ID),
        ...details.get(String(row.ID))!,
        requestMode: JSON.parse(String(row.CONFIG_JSON)).requestMode ?? "all",
        provider: row.PROVIDER as SourceProvider,
        name: String(row.DISPLAY_NAME),
        active: Boolean(row.ACTIVE),
        lastSyncedAt: row.LAST_SYNC_AT ? fromTimestamp(row.LAST_SYNC_AT) : null,
        nextSyncAt: fromTimestamp(row.NEXT_SYNC_AT),
        error: row.LAST_ERROR ? String(row.LAST_ERROR) : null,
        imported: Number(row.IMPORTED_COUNT),
        skipped: Number(row.SKIPPED_COUNT),
        syncing: Boolean(
          row.LEASE_UNTIL &&
          fromTimestamp(row.LEASE_UNTIL) > new Date().toISOString(),
        ),
      })),
    };
  });
}
export async function browseSources(
  actor: Actor,
  provider: SourceProvider,
  parentId: string,
  query: string,
) {
  const runtime = await sourceRuntime(actor, kind(provider));
  const options = await sourceOptions(runtime.token, provider, parentId, query);
  await readDatabase(async (sql) => {
    await sourceOwner(sql, actor);
    const current = await connectionRow(sql, actor, kind(provider));
    if (!current?.ACTIVE || Number(current.VERSION) !== runtime.version)
      throw new DomainError(
        "SOURCE_CHANGED",
        "The connection changed. Load the sources again.",
        409,
      );
  });
  return { options };
}
export async function selectSource(actor: Actor, input: SourceSelection) {
  const selection = sourceSelectionSchema.parse(input);
  const runtime = await sourceRuntime(actor, kind(selection.provider));
  const config = await validateSource(
    runtime.token,
    selection,
    runtime.accountId,
  );
  return writeDatabase(async (sql) => {
    await sourceOwner(sql, actor);
    const connection = await connectionRow(
      sql,
      actor,
      kind(selection.provider),
    );
    if (!connection?.ACTIVE || Number(connection.VERSION) !== runtime.version)
      throw new DomainError(
        "SOURCE_CHANGED",
        "The connection changed. Choose the source again.",
        409,
      );
    const key = digest({
      provider: selection.provider,
      rootId: config.rootId,
      parentId: config.parentId,
      accountId: runtime.accountId,
    });
    const [existing] = await sql.query(
      "SELECT ID,ACTIVE,CONNECTION_VERSION,CONFIG_JSON FROM CONNECTED_SOURCES WHERE WORKSPACE_ID=? AND SOURCE_KEY=?",
      [actor.workspaceId, key],
    );
    if (
      existing?.ACTIVE &&
      Number(existing.CONNECTION_VERSION) === runtime.version &&
      (JSON.parse(String(existing.CONFIG_JSON)).requestMode ?? "all") ===
        config.requestMode
    )
      return { id: String(existing.ID) };
    // The deterministic source identity is protected by the Exasol primary key.
    const sourceId = `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-8${key.slice(17, 20)}-${key.slice(20, 32)}`;
    const id = existing ? String(existing.ID) : sourceId;
    if (existing)
      await sql.execute(
        "UPDATE CONNECTED_SOURCES SET CONFIG_JSON=?,DISPLAY_NAME=?,CONNECTION_VERSION=?,VERSION=VERSION+1,ACTIVE=TRUE,CURSOR_JSON=NULL,NEXT_SYNC_AT=?,LAST_ERROR=NULL,LEASE_ID=NULL,LEASE_UNTIL=NULL WHERE WORKSPACE_ID=? AND ID=?",
        [
          JSON.stringify(config),
          config.name,
          runtime.version,
          date(),
          actor.workspaceId,
          id,
        ],
      );
    else {
      const [count] = await sql.query(
        "SELECT COUNT(*) AS TOTAL FROM CONNECTED_SOURCES WHERE WORKSPACE_ID=?",
        [actor.workspaceId],
      );
      if (Number(count.TOTAL) >= 24)
        throw new DomainError(
          "SOURCE_LIMIT",
          "This workspace supports up to 24 connected sources.",
          422,
        );
      await sql.execute(
        "INSERT INTO CONNECTED_SOURCES (WORKSPACE_ID,ID,PROVIDER,SOURCE_KEY,CONFIG_JSON,DISPLAY_NAME,CONNECTION_VERSION,VERSION,ACTIVE,NEXT_SYNC_AT,SKIPPED_COUNT) VALUES (?,?,?,?,?,?,?,1,TRUE,?,0)",
        [
          actor.workspaceId,
          id,
          selection.provider,
          key,
          JSON.stringify(config),
          config.name,
          runtime.version,
          date(),
        ],
      );
    }
    return { id };
  });
}
export async function changeSource(
  actor: Actor,
  id: string,
  action: "pause" | "resume" | "sync",
) {
  const source = await readDatabase(async (sql) => {
    await sourceOwner(sql, actor);
    const [row] = await sql.query(
      "SELECT * FROM CONNECTED_SOURCES WHERE WORKSPACE_ID=? AND ID=?",
      [actor.workspaceId, id],
    );
    if (!row) throw new DomainError("NOT_FOUND", "Source not found.", 404);
    return row;
  });
  if (action === "resume") {
    const config = JSON.parse(String(source.CONFIG_JSON)) as SourceConfig;
    const runtime = await sourceRuntime(
      actor,
      kind(source.PROVIDER as SourceProvider),
    );
    if (config.accountId !== runtime.accountId)
      throw new DomainError(
        "SOURCE_ACCOUNT",
        "This source belongs to a different connected account. Choose a source from the current account.",
        409,
      );
    return selectSource(actor, {
      provider: source.PROVIDER as SourceProvider,
      rootId: config.rootId,
      parentId: config.parentId,
      shareWithWorkspace: true,
      requestMode: config.requestMode ?? "all",
    });
  }
  await writeDatabase(async (sql) => {
    await sourceOwner(sql, actor);
    if (action === "pause")
      await sql.execute(
        "UPDATE CONNECTED_SOURCES SET ACTIVE=FALSE,VERSION=VERSION+1,LEASE_ID=NULL,LEASE_UNTIL=NULL WHERE WORKSPACE_ID=? AND ID=?",
        [actor.workspaceId, id],
      );
    else
      await sql.execute(
        "UPDATE CONNECTED_SOURCES SET NEXT_SYNC_AT=? WHERE WORKSPACE_ID=? AND ID=? AND ACTIVE=TRUE AND LAST_ERROR IS NULL",
        [date(), actor.workspaceId, id],
      );
  });
  return { id };
}
type Claim = { source: Row; actor: Actor; lease: string };
async function assertClaim(sql: SqlSession, claim: Claim) {
  const member = await sourceOwner(sql, claim.actor);
  const [current] = await sql.query(
    "SELECT ID FROM CONNECTED_SOURCES WHERE WORKSPACE_ID=? AND ID=? AND VERSION=? AND ACTIVE=TRUE AND LEASE_ID=? AND LEASE_UNTIL>?",
    [
      claim.actor.workspaceId,
      claim.source.ID,
      claim.source.VERSION,
      claim.lease,
      date(),
    ],
  );
  const connection = await connectionRow(
    sql,
    claim.actor,
    kind(claim.source.PROVIDER as SourceProvider),
  );
  if (
    !current ||
    !connection?.ACTIVE ||
    Number(connection.VERSION) !== Number(claim.source.CONNECTION_VERSION) ||
    connection.OWNER_ID !== claim.actor.userId
  )
    throw new DomainError(
      "SOURCE_CHANGED",
      "Sync stopped because source access changed.",
      409,
    );
  return member;
}
async function storeItem(claim: Claim, input: SourceItem) {
  await writeDatabase(async (sql) => {
    await assertClaim(sql, claim);
    await persistItem(sql, claim.actor, claim.source, input);
  });
}
async function persistItem(
  sql: SqlSession,
  actor: Actor,
  source: Row,
  input: SourceItem,
  accept = false,
) {
  const member = await sourceOwner(sql, actor);
  const [previous] = await sql.query(
    "SELECT * FROM SOURCE_ITEMS WHERE WORKSPACE_ID=? AND SOURCE_ID=? AND EXTERNAL_ID=?",
    [actor.workspaceId, source.ID, input.id],
  );
  const hash = digest(input);
  if (previous?.CONTENT_HASH === hash && !accept) return;
  const provider = source.PROVIDER as SourceProvider;
  let resourceId = previous?.RESOURCE_ID ? String(previous.RESOURCE_ID) : null;
  let resourceKind = provider === "sharepoint" ? "knowledge" : "request";
  let lastValues: Intake | null = null;
  if (input.deleted || input.skip) {
    resourceKind = input.deleted ? "deleted" : "skipped";
    if (provider === "sharepoint")
      await retireDocument(sql, actor, String(source.ID), input.id, resourceId);
  } else if (
    !resourceId &&
    !accept &&
    input.detection &&
    input.detection.decision !== "request"
  ) {
    resourceKind = input.detection.decision;
  } else {
    const externalSource: ExternalSource = {
      provider,
      sourceId: String(source.ID),
      externalId: input.id,
      url: input.url,
      author: input.author,
      updatedAt: input.updatedAt,
      truncated: input.truncated,
    };
    if (provider === "sharepoint") {
      resourceId = await storeDocument(
        sql,
        actor,
        input,
        externalSource,
        resourceId,
        ["deleted", "skipped"].includes(String(previous?.RESOURCE_KIND)),
      );
    } else {
      const values: Intake = {
        title: input.title,
        businessQuestion: `${input.text}${input.truncated ? "\n\n[Excerpt — open the original thread for full context.]" : ""}`,
        reportingPeriod: "",
        dataset: "",
      };
      lastValues = values;
      if (!resourceId) {
        const request = await insertRequest(
          sql,
          actor,
          member,
          randomUUID(),
          hash,
          values,
          true,
        );
        resourceId = request.id;
        await sql.execute(
          "UPDATE REQUESTS SET SOURCE_JSON=? WHERE WORKSPACE_ID=? AND ID=?",
          [JSON.stringify(externalSource), actor.workspaceId, resourceId],
        );
      } else {
        const current = await getRequest(sql, actor, member, resourceId);
        const old = JSON.parse(
          String(previous?.LAST_VALUES_JSON || "{}"),
        ) as Partial<Intake>;
        const next = {
          ...current,
          externalSource,
          title: current.title === old.title ? values.title : current.title,
          businessQuestion:
            current.businessQuestion === old.businessQuestion
              ? values.businessQuestion
              : current.businessQuestion,
          version: current.version + 1,
          updatedAt: new Date().toISOString(),
        };
        assertRecordSize(next);
        await sql.execute(
          "UPDATE REQUESTS SET TITLE=?,BUSINESS_QUESTION=?,SOURCE_JSON=?,VERSION=?,UPDATED_AT=? WHERE WORKSPACE_ID=? AND ID=? AND VERSION=?",
          [
            next.title,
            next.businessQuestion,
            JSON.stringify(externalSource),
            next.version,
            sqlTimestamp(next.updatedAt),
            actor.workspaceId,
            resourceId,
            current.version,
          ],
        );
        await recordChange(
          sql,
          actor,
          next,
          randomUUID(),
          hash,
          "source_updated",
          false,
        );
      }
    }
  }
  if (previous)
    await sql.execute(
      "UPDATE SOURCE_ITEMS SET CONTENT_HASH=?,RESOURCE_ID=?,RESOURCE_KIND=?,LAST_VALUES_JSON=?,ITEM_JSON=?,DETAIL=? WHERE WORKSPACE_ID=? AND SOURCE_ID=? AND EXTERNAL_ID=?",
      [
        hash,
        resourceId,
        resourceKind,
        lastValues ? JSON.stringify(lastValues) : previous.LAST_VALUES_JSON,
        resourceKind === "review"
          ? JSON.stringify(input)
          : JSON.stringify({ title: input.title }),
        input.note ||
          (input.truncated && provider === "sharepoint"
            ? "Import limit reached; only part of this document is searchable."
            : input.detection?.reason) ||
          null,
        actor.workspaceId,
        source.ID,
        input.id,
      ],
    );
  else
    await sql.execute(
      "INSERT INTO SOURCE_ITEMS (WORKSPACE_ID,SOURCE_ID,EXTERNAL_ID,CONTENT_HASH,RESOURCE_ID,RESOURCE_KIND,LAST_VALUES_JSON,ITEM_JSON,DETAIL) VALUES (?,?,?,?,?,?,?,?,?)",
      [
        actor.workspaceId,
        source.ID,
        input.id,
        hash,
        resourceId,
        resourceKind,
        lastValues ? JSON.stringify(lastValues) : null,
        resourceKind === "review"
          ? JSON.stringify(input)
          : JSON.stringify({ title: input.title }),
        input.note ||
          (input.truncated && provider === "sharepoint"
            ? "Import limit reached; only part of this document is searchable."
            : input.detection?.reason) ||
          null,
      ],
    );
}
export async function setRequestMode(
  actor: Actor,
  id: string,
  mode: "detect" | "all",
) {
  return writeDatabase(async (sql) => {
    await sourceOwner(sql, actor);
    const [source] = await sql.query(
      "SELECT * FROM CONNECTED_SOURCES WHERE WORKSPACE_ID=? AND ID=?",
      [actor.workspaceId, id],
    );
    if (!source || source.PROVIDER === "sharepoint")
      throw new DomainError(
        "SOURCE_SCOPE",
        "Choose a connected chat channel.",
        422,
      );
    const config = JSON.parse(String(source.CONFIG_JSON)) as SourceConfig;
    if ((config.requestMode ?? "all") === mode) return;
    await sql.execute(
      "UPDATE CONNECTED_SOURCES SET CONFIG_JSON=?,VERSION=VERSION+1,CURSOR_JSON=NULL,LEASE_ID=NULL,LEASE_UNTIL=NULL,NEXT_SYNC_AT=? WHERE WORKSPACE_ID=? AND ID=?",
      [
        JSON.stringify({ ...config, requestMode: mode }),
        date(),
        actor.workspaceId,
        id,
      ],
    );
  });
}
export async function reviewSourceItem(
  actor: Actor,
  sourceId: string,
  externalId: string,
  hash: string,
  decision: "accept" | "dismiss",
) {
  return writeDatabase(async (sql) => {
    await sourceOwner(sql, actor);
    const [source] = await sql.query(
      "SELECT * FROM CONNECTED_SOURCES WHERE WORKSPACE_ID=? AND ID=? AND ACTIVE=TRUE",
      [actor.workspaceId, sourceId],
    );
    if (!source)
      throw new DomainError(
        "SOURCE_CHANGED",
        "Resume this source before reviewing requests.",
        409,
      );
    const connection = await connectionRow(
      sql,
      actor,
      kind(source.PROVIDER as SourceProvider),
    );
    if (
      !connection?.ACTIVE ||
      Number(connection.VERSION) !== Number(source.CONNECTION_VERSION) ||
      connection.OWNER_ID !== actor.userId
    )
      throw new DomainError(
        "SOURCE_CHANGED",
        "Reconnect this source before reviewing requests.",
        409,
      );
    const [item] = await sql.query(
      "SELECT * FROM SOURCE_ITEMS WHERE WORKSPACE_ID=? AND SOURCE_ID=? AND EXTERNAL_ID=?",
      [actor.workspaceId, sourceId, externalId],
    );
    if (!item || item.CONTENT_HASH !== hash)
      throw new DomainError(
        "SOURCE_CHANGED",
        "This message changed. Reload and review the current text.",
        409,
      );
    if (item.RESOURCE_KIND !== "review") return;
    if (decision === "dismiss")
      await sql.execute(
        "UPDATE SOURCE_ITEMS SET RESOURCE_KIND='dismissed',ITEM_JSON=NULL WHERE WORKSPACE_ID=? AND SOURCE_ID=? AND EXTERNAL_ID=?",
        [actor.workspaceId, sourceId, externalId],
      );
    else
      await persistItem(
        sql,
        actor,
        source,
        JSON.parse(String(item.ITEM_JSON)) as SourceItem,
        true,
      );
  });
}
export async function syncOneSource(workspaceId: string, id: string) {
  const claim = await writeDatabase(async (sql) => {
    const [source] = await sql.query(
      "SELECT * FROM CONNECTED_SOURCES WHERE WORKSPACE_ID=? AND ID=? AND ACTIVE=TRUE AND NEXT_SYNC_AT<=? AND (LEASE_UNTIL IS NULL OR LEASE_UNTIL<=?)",
      [workspaceId, id, date(), date()],
    );
    if (!source) return null;
    const connection = await connectionRow(
      sql,
      { workspaceId, userId: "" },
      kind(source.PROVIDER as SourceProvider),
    );
    if (
      !connection?.ACTIVE ||
      Number(connection.VERSION) !== Number(source.CONNECTION_VERSION)
    )
      return null;
    const actor = { workspaceId, userId: String(connection.OWNER_ID) },
      lease = randomUUID();
    await sourceOwner(sql, actor);
    const changed = await sql.execute(
      "UPDATE CONNECTED_SOURCES SET LEASE_ID=?,LEASE_UNTIL=? WHERE WORKSPACE_ID=? AND ID=? AND VERSION=? AND ACTIVE=TRUE AND (LEASE_UNTIL IS NULL OR LEASE_UNTIL<=?)",
      [
        lease,
        date(Date.now() + 10 * 60_000),
        workspaceId,
        id,
        source.VERSION,
        date(),
      ],
    );
    return changed === 1 ? { source, actor, lease } : null;
  });
  if (!claim) return;
  try {
    const runtime = await sourceRuntime(
      claim.actor,
      kind(claim.source.PROVIDER as SourceProvider),
    );
    if (runtime.version !== Number(claim.source.CONNECTION_VERSION))
      throw new DomainError("SOURCE_CHANGED", "The connection changed.", 409);
    const page = await fetchSourcePage(
      claim.source.PROVIDER as SourceProvider,
      runtime.token,
      JSON.parse(String(claim.source.CONFIG_JSON)),
      claim.source.CURSOR_JSON
        ? (JSON.parse(String(claim.source.CURSOR_JSON)) as SourceCursor)
        : null,
    );
    for (const item of page.items) await storeItem(claim, item);
    await writeDatabase(async (sql) => {
      await assertClaim(sql, claim);
      const [count] = await sql.query(
        "SELECT COUNT(*) AS TOTAL FROM SOURCE_ITEMS WHERE WORKSPACE_ID=? AND SOURCE_ID=? AND RESOURCE_KIND='skipped'",
        [workspaceId, id],
      );
      const more =
        page.cursor &&
        (claim.source.PROVIDER !== "sharepoint" ||
          page.cursor.latest === "paging");
      await sql.execute(
        "UPDATE CONNECTED_SOURCES SET CURSOR_JSON=?,LAST_SYNC_AT=?,NEXT_SYNC_AT=?,LAST_ERROR=NULL,SKIPPED_COUNT=?,LEASE_ID=NULL,LEASE_UNTIL=NULL WHERE WORKSPACE_ID=? AND ID=? AND LEASE_ID=?",
        [
          page.cursor ? JSON.stringify(page.cursor) : null,
          date(),
          date(Date.now() + (more ? 65_000 : 5 * 60_000)),
          Number(count.TOTAL),
          workspaceId,
          id,
          claim.lease,
        ],
      );
    });
  } catch (error) {
    const message =
      error instanceof SourceError || error instanceof DomainError
        ? error.message.slice(0, 500)
        : "Sync could not finish. Check source access and the local database; Loom will retry.";
    await writeDatabase((sql) =>
      sql.execute(
        "UPDATE CONNECTED_SOURCES SET LAST_ERROR=?,NEXT_SYNC_AT=?,LEASE_ID=NULL,LEASE_UNTIL=NULL WHERE WORKSPACE_ID=? AND ID=? AND LEASE_ID=?",
        [
          message,
          date(
            Date.now() +
              (error instanceof SourceError ? error.retrySeconds : 300) * 1000,
          ),
          workspaceId,
          id,
          claim.lease,
        ],
      ),
    );
  }
}
let running: Promise<void> | null = null;
export function syncDueSources(): Promise<void> {
  if (running) return running;
  running = (async () => {
    const rows = await readDatabase((sql) =>
      sql.query(
        "SELECT WORKSPACE_ID,ID FROM CONNECTED_SOURCES WHERE ACTIVE=TRUE AND NEXT_SYNC_AT<=? AND (LEASE_UNTIL IS NULL OR LEASE_UNTIL<=?) ORDER BY NEXT_SYNC_AT LIMIT 24",
        [date(), date()],
      ),
    );
    for (const row of rows) {
      try {
        await syncOneSource(String(row.WORKSPACE_ID), String(row.ID));
      } catch {
        /* One revoked membership or unavailable source must not stop other sources. */
      }
    }
  })().finally(() => {
    running = null;
  });
  return running;
}
export function startSourceSync() {
  if (!isConfigured() || process.env.LOOM_SOURCE_SYNC === "false") return;
  const state = globalThis as typeof globalThis & {
    loomSourceTimer?: ReturnType<typeof setTimeout>;
  };
  if (state.loomSourceTimer) return;
  const tick = async () => {
    try {
      await syncDueSources();
    } catch {
      /* Readiness may precede database startup. Retry without logging credentials or source data. */
    }
    state.loomSourceTimer = setTimeout(() => {
      void tick();
    }, 15_000);
    state.loomSourceTimer.unref();
  };
  state.loomSourceTimer = setTimeout(() => {
    void tick();
  }, 15_000);
  state.loomSourceTimer.unref();
}
