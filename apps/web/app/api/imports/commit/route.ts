import { csvCommitSchema } from "@loom/contracts";
import { commitImport } from "@/server/imports";
import { endpoint, jsonBody, requireActor } from "@/server/http";
export const runtime = "nodejs";
export const POST = endpoint(async (request) => {
  const actor = await requireActor();
  const body = csvCommitSchema.parse(await jsonBody(request));
  return commitImport(actor, body.batchId, body.previewHash, body.commandId);
}, true);
