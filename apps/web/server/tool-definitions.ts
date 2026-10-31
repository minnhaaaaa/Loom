import "server-only";
import { createHash } from "node:crypto";
import {
  dataRequestTemplate,
  toolSpecSchema,
  type Actor,
  type PublishedTool,
} from "@loom/contracts";
import {
  DatabaseError,
  fromTimestamp,
  type Row,
  type SqlSession,
} from "@loom/db-exasol";

export function mapPublishedTool(row: Row): PublishedTool {
  const spec = toolSpecSchema.parse(JSON.parse(String(row.SPEC_JSON)));
  const hash = createHash("sha256").update(JSON.stringify(spec)).digest("hex");
  if (hash !== row.SPEC_HASH)
    throw new DatabaseError(
      "TOOL_INTEGRITY",
      "The published tool failed its integrity check.",
    );
  return {
    revision: Number(row.REVISION),
    spec,
    publishedAt: row.PUBLISHED_AT ? fromTimestamp(row.PUBLISHED_AT) : null,
  };
}

// The caller authorizes workspace access. This module intentionally has no desk dependency.
export async function publishedTool(
  sql: SqlSession,
  actor: Actor,
): Promise<PublishedTool> {
  const [pointer] = await sql.query(
    "SELECT CURRENT_REVISION FROM TOOLS WHERE WORKSPACE_ID = ?",
    [actor.workspaceId],
  );
  if (!pointer)
    return { revision: 1, spec: dataRequestTemplate, publishedAt: null };
  const [row] = await sql.query(
    "SELECT REVISION,SPEC_JSON,SPEC_HASH,PUBLISHED_AT FROM TOOL_REVISIONS WHERE WORKSPACE_ID = ? AND REVISION = ?",
    [actor.workspaceId, Number(pointer.CURRENT_REVISION)],
  );
  if (!row)
    throw new DatabaseError(
      "TOOL_INTEGRITY",
      "The current published tool is unavailable.",
    );
  return mapPublishedTool(row);
}
