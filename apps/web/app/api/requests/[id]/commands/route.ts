import { z } from "zod";
import { mutationSchema } from "@loom/contracts";
import { mutateRequest } from "@/server/desk";
import { endpoint, jsonBody, requireActor } from "@/server/http";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const params = await context.params;
  return endpoint(async (req) => {
    const actor = await requireActor();
    const id = z.uuid().parse(params.id);
    const body = mutationSchema.parse(await jsonBody(req));
    return mutateRequest(
      actor,
      id,
      body.commandId,
      body.expectedVersion,
      body.command,
      body.expectedToolRevision,
    );
  }, true)(request);
}
