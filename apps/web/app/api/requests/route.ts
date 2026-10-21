import { createSchema } from "@loom/contracts";
import { createRequest } from "@/server/desk";
import { endpoint, jsonBody, requireActor } from "@/server/http";
export const runtime = "nodejs";
export const POST = endpoint(async (request) => {
  const actor = await requireActor();
  const { commandId, values } = createSchema.parse(await jsonBody(request));
  return createRequest(actor, commandId, values);
}, true);
