import { knowledgeCreateSchema } from "@loom/contracts";
import { createKnowledge, listKnowledge } from "@/server/knowledge";
import { endpoint, jsonBody, requireActor } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = endpoint(async () => listKnowledge(await requireActor()));
export const POST = endpoint(async (request) => {
  const actor = await requireActor();
  const body = knowledgeCreateSchema.parse(await jsonBody(request));
  return createKnowledge(actor, body.commandId, body.values);
}, true);
