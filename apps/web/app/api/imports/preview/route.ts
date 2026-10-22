import { csvPreviewSchema } from "@loom/contracts";
import { previewImport } from "@/server/imports";
import { endpoint, jsonBody, requireActor } from "@/server/http";
export const runtime = "nodejs";
export const POST = endpoint(async (request) => {
  const actor = await requireActor();
  const body = csvPreviewSchema.parse(await jsonBody(request, 6 * 1024 * 1024));
  return previewImport(actor, body.text, body.mapping);
}, true);
