import { z } from "zod";
import { proposalReviewSchema } from "@loom/contracts";
import { reviewProposal } from "@/server/triage";
import { endpoint, jsonBody, requireActor } from "@/server/http";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  return endpoint(async () => {
    const actor = await requireActor(),
      id = z.uuid().parse((await context.params).id);
    const body = proposalReviewSchema.parse(await jsonBody(request));
    return reviewProposal(actor, id, body.commandId, body.hash, body.action);
  }, true)(request);
}
