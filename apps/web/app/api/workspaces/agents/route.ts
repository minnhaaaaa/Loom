import { createAgentConnectionSchema } from "@loom/contracts";
import { createAgentConnection, listAgentConnections } from "@/server/settings";
import { endpoint, jsonBody, requireActor } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = endpoint(async () =>
  listAgentConnections(await requireActor()),
);
export const POST = endpoint(async (request) => {
  const actor = await requireActor();
  const values = createAgentConnectionSchema.parse(await jsonBody(request));
  return createAgentConnection(actor, values);
}, true);
