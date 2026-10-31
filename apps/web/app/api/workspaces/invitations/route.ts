import { createInvitationSchema } from "@loom/contracts";
import { createInvitation } from "@/server/workspaces";
import { endpoint, jsonBody, requireActor } from "@/server/http";
export const runtime = "nodejs";
export const POST = endpoint(async (request) => {
  const actor = await requireActor();
  const values = createInvitationSchema.parse(await jsonBody(request));
  return createInvitation(actor, values.commandId, values.role);
}, true);
