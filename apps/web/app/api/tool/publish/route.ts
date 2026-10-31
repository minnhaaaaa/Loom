import { publishToolSchema } from "@loom/contracts";
import { endpoint, jsonBody, requireActor } from "@/server/http";
import { publishTool } from "@/server/tools";
export const runtime = "nodejs";
export const POST = endpoint(async (request) => {
  const actor = await requireActor();
  const body = publishToolSchema.parse(await jsonBody(request));
  return publishTool(
    actor,
    body.commandId,
    body.draftId,
    body.expectedRevision,
    body.hash,
  );
}, true);
