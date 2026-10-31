import { createToolDraftSchema } from "@loom/contracts";
import { endpoint, jsonBody, requireActor } from "@/server/http";
import { createToolDraft } from "@/server/tools";
export const runtime = "nodejs";
export const POST = endpoint(async (request) => {
  const actor = await requireActor();
  const body = createToolDraftSchema.parse(await jsonBody(request, 128_000));
  return createToolDraft(
    actor,
    body.commandId,
    body.expectedRevision,
    body.spec,
    body.instructions,
  );
}, true);
