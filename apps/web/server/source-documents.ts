import "server-only";
import { randomUUID } from "node:crypto";
import {
  knowledgeInputSchema,
  type Actor,
  type ExternalSource,
  type KnowledgeInput,
} from "@loom/contracts";
import { sqlTimestamp, type SqlSession } from "@loom/db-exasol";
import { digest } from "./desk";
import { agentEvent, getKnowledge } from "./knowledge";
import type { SourceItem } from "./source-adapters";

export async function retireDocument(
  sql: SqlSession,
  actor: Actor,
  sourceId: string,
  externalId: string,
  legacyId: string | null,
) {
  const rows = await sql.query(
    "SELECT KNOWLEDGE_ID FROM SOURCE_DOCUMENT_PARTS WHERE WORKSPACE_ID=? AND SOURCE_ID=? AND EXTERNAL_ID=?",
    [actor.workspaceId, sourceId, externalId],
  );
  const ids = new Set(rows.map((row) => String(row.KNOWLEDGE_ID)));
  if (legacyId) ids.add(legacyId);
  for (const id of ids) {
    const current = await getKnowledge(sql, actor, id);
    if (current.state === "approved") {
      await sql.execute(
        "UPDATE KNOWLEDGE_ENTRIES SET LIFECYCLE='retired',VERSION=VERSION+1 WHERE WORKSPACE_ID=? AND ID=?",
        [actor.workspaceId, id],
      );
      await agentEvent(sql, actor, id, "source_removed", current.version + 1);
      await sql.execute(
        "UPDATE SOURCE_DOCUMENT_PARTS SET REMOVED=TRUE WHERE WORKSPACE_ID=? AND SOURCE_ID=? AND EXTERNAL_ID=? AND KNOWLEDGE_ID=?",
        [actor.workspaceId, sourceId, externalId, id],
      );
    }
  }
}

/** Replace one document's passages atomically, preserving IDs and human retirements. */
export async function storeDocument(
  sql: SqlSession,
  actor: Actor,
  input: SourceItem,
  externalSource: ExternalSource,
  legacyId: string | null,
  wasRemoved: boolean,
) {
  const sourceId = externalSource.sourceId;
  const previous = await sql.query(
    "SELECT * FROM SOURCE_DOCUMENT_PARTS WHERE WORKSPACE_ID=? AND SOURCE_ID=? AND EXTERNAL_ID=? ORDER BY PART_NUMBER",
    [actor.workspaceId, sourceId, input.id],
  );
  const parts = input.parts || [{ text: input.text }];
  let first = "";
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index],
      number = index + 1;
    const mapping = previous.find((row) => Number(row.PART_NUMBER) === number);
    const existingId = mapping
      ? String(mapping.KNOWLEDGE_ID)
      : index === 0
        ? legacyId
        : null;
    const id = existingId || randomUUID();
    if (!index) first = id;
    const suffix = part.page
      ? ` · p. ${part.page}${parts.length > 1 ? ` · ${number}` : ""}`
      : parts.length > 1
        ? ` · part ${number}`
        : "";
    const values: KnowledgeInput = knowledgeInputSchema.parse({
      title: input.title.slice(0, 160 - suffix.length) + suffix,
      kind: "reference",
      content: part.text,
      dataset: "",
      ownerId: null,
      effectiveFrom: new Date().toISOString().slice(0, 10),
      effectiveUntil: null,
      supersedesId: null,
      externalSource: {
        ...externalSource,
        part: number,
        ...(part.page ? { page: part.page } : {}),
      },
    });
    if (existingId) {
      const current = await getKnowledge(sql, actor, existingId);
      values.effectiveFrom = current.effectiveFrom;
      const state =
        current.state === "retired" && !(mapping ? mapping.REMOVED : wasRemoved)
          ? "retired"
          : "approved";
      if (digest(values) !== current.contentHash || state !== current.state) {
        await sql.execute(
          "UPDATE KNOWLEDGE_ENTRIES SET VERSION=VERSION+1,LIFECYCLE=?,CONTENT_JSON=?,CONTENT_HASH=? WHERE WORKSPACE_ID=? AND ID=?",
          [
            state,
            JSON.stringify(values),
            digest(values),
            actor.workspaceId,
            id,
          ],
        );
        await agentEvent(sql, actor, id, "source_updated", current.version + 1);
      }
    } else {
      await sql.execute(
        "INSERT INTO KNOWLEDGE_ENTRIES (WORKSPACE_ID,ID,VERSION,LIFECYCLE,KIND,DATASET,CONTENT_JSON,CONTENT_HASH,CREATED_BY,CREATED_AT,APPROVED_BY) VALUES (?,?,1,'approved','reference',NULL,?,?,?,?,?)",
        [
          actor.workspaceId,
          id,
          JSON.stringify(values),
          digest(values),
          actor.userId,
          sqlTimestamp(new Date().toISOString()),
          actor.userId,
        ],
      );
      await agentEvent(sql, actor, id, "source_imported", 1);
    }
    if (mapping)
      await sql.execute(
        "UPDATE SOURCE_DOCUMENT_PARTS SET REMOVED=FALSE WHERE WORKSPACE_ID=? AND SOURCE_ID=? AND EXTERNAL_ID=? AND PART_NUMBER=?",
        [actor.workspaceId, sourceId, input.id, number],
      );
    else
      await sql.execute(
        "INSERT INTO SOURCE_DOCUMENT_PARTS (WORKSPACE_ID,SOURCE_ID,EXTERNAL_ID,PART_NUMBER,KNOWLEDGE_ID,REMOVED) VALUES (?,?,?,?,?,FALSE)",
        [actor.workspaceId, sourceId, input.id, number, id],
      );
  }
  for (const removed of previous.filter(
    (row) => Number(row.PART_NUMBER) > parts.length && !row.REMOVED,
  )) {
    const current = await getKnowledge(
      sql,
      actor,
      String(removed.KNOWLEDGE_ID),
    );
    if (current.state !== "approved") continue; // A human retirement stays retired even if the passage returns.
    await sql.execute(
      "UPDATE KNOWLEDGE_ENTRIES SET LIFECYCLE='retired',VERSION=VERSION+1 WHERE WORKSPACE_ID=? AND ID=?",
      [actor.workspaceId, current.id],
    );
    await sql.execute(
      "UPDATE SOURCE_DOCUMENT_PARTS SET REMOVED=TRUE WHERE WORKSPACE_ID=? AND SOURCE_ID=? AND EXTERNAL_ID=? AND PART_NUMBER=?",
      [actor.workspaceId, sourceId, input.id, removed.PART_NUMBER],
    );
    await agentEvent(
      sql,
      actor,
      current.id,
      "source_removed",
      current.version + 1,
    );
  }
  return first;
}
