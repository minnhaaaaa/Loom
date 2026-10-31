import { z } from "zod";
import { revokeAgentConnectionSchema } from "@loom/contracts";
import { revokeAgentConnection } from "@/server/settings";
import { endpoint, jsonBody, requireActor } from "@/server/http";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return endpoint(async () => {
    const actor = await requireActor();
    const id = z.uuid().parse((await context.params).id);
    const values = revokeAgentConnectionSchema.parse(await jsonBody(request));
    return revokeAgentConnection(
      actor,
      id,
      values.commandId,
      values.expectedVersion,
    );
  }, true)(request);
}
