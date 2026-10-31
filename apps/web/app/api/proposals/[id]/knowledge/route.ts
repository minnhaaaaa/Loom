import { z } from "zod";
import { proposalKnowledgeSchema } from "@loom/contracts";
import { createKnowledgeFromProposal } from "@/server/knowledge";
import { endpoint, jsonBody, requireActor } from "@/server/http";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  return endpoint(async () => {
    const actor = await requireActor();
    const id = z.uuid().parse((await context.params).id);
    const body = proposalKnowledgeSchema.parse(await jsonBody(request));
    return createKnowledgeFromProposal(actor, id, body);
  }, true)(request);
}
