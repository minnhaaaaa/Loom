import { z } from "zod";
import { knowledgeActionSchema } from "@loom/contracts";
import { readDatabase } from "@loom/db-exasol";
import {
  changeKnowledge,
  getKnowledge,
  requireOperator,
} from "@/server/knowledge";
import { endpoint, jsonBody, requireActor } from "@/server/http";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  return endpoint(async () => {
    const actor = await requireActor(),
      id = z.uuid().parse((await context.params).id);
    return readDatabase(async (sql) => {
      await requireOperator(sql, actor);
      return getKnowledge(sql, actor, id);
    });
  })(request);
}
export async function POST(request: Request, context: Context) {
  return endpoint(async () => {
    const actor = await requireActor(),
      id = z.uuid().parse((await context.params).id);
    const body = knowledgeActionSchema.parse(await jsonBody(request));
    return changeKnowledge(
      actor,
      id,
      body.commandId,
      body.expectedVersion,
      body.action,
    );
  }, true)(request);
}
