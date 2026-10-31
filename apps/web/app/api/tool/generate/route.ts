import { generateToolSchema } from "@loom/contracts";
import { endpoint, jsonBody, requireActor } from "@/server/http";
import { generateToolDraft } from "@/server/tools";
export const runtime = "nodejs";
export const POST = endpoint(async (request) => {
  const actor = await requireActor();
  const body = generateToolSchema.parse(await jsonBody(request, 128_000));
  return generateToolDraft(
    actor,
    body.commandId,
    body.expectedRevision,
    body.instructions,
    body.baseSpec,
  );
}, true);
