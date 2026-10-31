import "server-only";
import { randomUUID } from "node:crypto";
import { DomainError, canOperate } from "@loom/domain";
import {
  fromTimestamp,
  readDatabase,
  sqlTimestamp,
  writeDatabase,
  type SqlSession,
} from "@loom/db-exasol";
import {
  deskQuerySchema,
  type Actor,
  type DeskQuery,
  type Membership,
} from "@loom/contracts";
import {
  digest,
  insertRequest,
  mapRequest,
  membership,
  receipt,
  requestFilter,
  requestSelect,
  visibleRequest,
} from "./desk";
import {
  csvCell,
  parseCsv,
  reviewCsv,
  type CsvMapping,
  type CsvReview,
} from "./csv";
import { publishedTool } from "./tool-definitions";
export type ImportPreview = CsvReview & {
  batchId: string;
  previewHash: string;
  expiresAt: string;
  committedIds: string[] | null;
};
async function operator(sql: SqlSession, actor: Actor): Promise<Membership> {
  const member = await membership(sql, actor);
  if (!canOperate(member))
    throw new DomainError(
      "ACCESS_DENIED",
      "CSV imports require an owner or operator.",
      403,
    );
  return member;
}
export async function previewImport(
  actor: Actor,
  text: string,
  mapping?: CsvMapping,
): Promise<{ headers: string[] } | ImportPreview> {
  // Reject unauthorized uploads before parsing or retaining their contents.
  await readDatabase((sql) => operator(sql, actor));
  const records = parseCsv(text);
  if (!mapping) return { headers: records[0] };
  const review = reviewCsv(records, mapping);
  const sourceHash = digest(text),
    previewHash = digest(review);
  return writeDatabase(async (sql) => {
    await operator(sql, actor);
    const [existing] = await sql.query(
      "SELECT ID,PREVIEW_JSON,EXPIRES_AT,COMMITTED_IDS_JSON FROM IMPORT_BATCHES WHERE WORKSPACE_ID = ? AND ACTOR_ID = ? AND SOURCE_HASH = ? AND PREVIEW_HASH = ? ORDER BY CREATED_AT DESC LIMIT 1",
      [actor.workspaceId, actor.userId, sourceHash, previewHash],
    );
    // Reopening the same committed file reconciles its saved import rather than duplicating it.
    if (
      existing &&
      (existing.COMMITTED_IDS_JSON ||
        fromTimestamp(existing.EXPIRES_AT) > new Date().toISOString())
    )
      return {
        ...(JSON.parse(String(existing.PREVIEW_JSON)) as CsvReview),
        batchId: String(existing.ID),
        previewHash,
        expiresAt: fromTimestamp(existing.EXPIRES_AT),
        committedIds: existing.COMMITTED_IDS_JSON
          ? (JSON.parse(String(existing.COMMITTED_IDS_JSON)) as string[])
          : null,
      };
    const batchId = randomUUID(),
      now = new Date().toISOString(),
      expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    await sql.execute(
      "INSERT INTO IMPORT_BATCHES (WORKSPACE_ID,ID,ACTOR_ID,SOURCE_HASH,PREVIEW_HASH,PREVIEW_JSON,CREATED_AT,EXPIRES_AT,COMMITTED_IDS_JSON) VALUES (?,?,?,?,?,?,?,?,NULL)",
      [
        actor.workspaceId,
        batchId,
        actor.userId,
        sourceHash,
        previewHash,
        JSON.stringify(review),
        sqlTimestamp(now),
        sqlTimestamp(expiresAt),
      ],
    );
    return { ...review, batchId, previewHash, expiresAt, committedIds: null };
  });
}
export async function commitImport(
  actor: Actor,
  batchId: string,
  previewHash: string,
  commandId: string,
) {
  const hash = digest({ type: "csv-import", batchId, previewHash });
  return writeDatabase(async (sql) => {
    const member = await operator(sql, actor);
    const saved = await receipt<{ batchId: string; ids: string[] }>(
      sql,
      actor,
      commandId,
      hash,
    );
    if (saved) return saved;
    const [batch] = await sql.query(
      "SELECT PREVIEW_HASH,PREVIEW_JSON,EXPIRES_AT,COMMITTED_IDS_JSON FROM IMPORT_BATCHES WHERE WORKSPACE_ID = ? AND ID = ? AND ACTOR_ID = ?",
      [actor.workspaceId, batchId, actor.userId],
    );
    if (!batch)
      throw new DomainError("NOT_FOUND", "Import preview not found.", 404);
    if (batch.PREVIEW_HASH !== previewHash)
      throw new DomainError(
        "PREVIEW_CONFLICT",
        "Review the current preview before importing.",
        409,
      );
    let ids: string[];
    if (batch.COMMITTED_IDS_JSON)
      ids = JSON.parse(String(batch.COMMITTED_IDS_JSON));
    else {
      if (fromTimestamp(batch.EXPIRES_AT) <= new Date().toISOString())
        throw new DomainError(
          "PREVIEW_EXPIRED",
          "Preview expired. Upload and review the file again.",
          409,
        );
      const review = JSON.parse(String(batch.PREVIEW_JSON)) as CsvReview;
      if (
        digest(review) !== previewHash ||
        !review.rows.length ||
        review.rows.length > 100 ||
        review.rows.some((row) => !row.values || row.errors.length)
      )
        throw new DomainError(
          "INVALID_IMPORT",
          "Fix every row error and review the file again before importing.",
          422,
        );
      ids = [];
      for (const row of review.rows) {
        const record = await insertRequest(
          sql,
          actor,
          member,
          commandId,
          hash,
          row.values!,
          true,
        );
        ids.push(record.id);
      }
      await sql.execute(
        "UPDATE IMPORT_BATCHES SET COMMITTED_IDS_JSON = ? WHERE WORKSPACE_ID = ? AND ID = ? AND ACTOR_ID = ?",
        [JSON.stringify(ids), actor.workspaceId, batchId, actor.userId],
      );
    }
    const result = { batchId, ids };
    await sql.execute(
      "INSERT INTO COMMAND_RECEIPTS (WORKSPACE_ID,COMMAND_ID,ACTOR_ID,PAYLOAD_HASH,RESULT_JSON,CREATED_AT) VALUES (?,?,?,?,?,?)",
      [
        actor.workspaceId,
        commandId,
        actor.userId,
        hash,
        JSON.stringify(result),
        sqlTimestamp(new Date().toISOString()),
      ],
    );
    return result;
  });
}
export async function exportRequests(actor: Actor, input: Partial<DeskQuery>) {
  const query = deskQuerySchema.parse(input);
  return readDatabase(async (sql) => {
    const member = await membership(sql, actor),
      filter = requestFilter(member, query);
    const rows = await sql.query(
      `${requestSelect} WHERE R.WORKSPACE_ID = ?${filter.sql} ORDER BY R.CREATED_AT DESC,R.ID LIMIT 501`,
      [actor.workspaceId, ...filter.values],
    );
    if (rows.length > 500)
      throw new DomainError(
        "EXPORT_LIMIT",
        "Export supports up to 500 matching requests. Narrow the search or status filter.",
        422,
      );
    const fields = [
      "id",
      "title",
      "businessQuestion",
      "reportingPeriod",
      "dataset",
      "requesterName",
      "ownerName",
      "status",
      "dueAt",
      ...(member.role === "requester" ? [] : ["priority"]),
      "createdAt",
      "updatedAt",
      ...(await publishedTool(sql, actor)).spec.fields
        .filter((field) => field.id.startsWith("custom_"))
        .map((field) => field.id),
    ];
    return (
      "\ufeff" +
      [
        fields.map(csvCell).join(","),
        ...rows.map((row) => {
          const visible = visibleRequest(member, mapRequest(row));
          return fields
            .map((field) =>
              csvCell(
                field.startsWith("custom_")
                  ? visible.customValues?.[field]
                  : visible[field as keyof typeof visible],
              ),
            )
            .join(",");
        }),
      ].join("\r\n") +
      "\r\n"
    );
  });
}
