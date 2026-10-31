import { z } from "zod";
import { revokeInvitationSchema } from "@loom/contracts";
import { revokeInvitation } from "@/server/workspaces";
import { endpoint, jsonBody, requireActor } from "@/server/http";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return endpoint(async (request) => {
    const actor = await requireActor();
    const values = revokeInvitationSchema.parse(await jsonBody(request));
    return revokeInvitation(
      actor,
      z.uuid().parse(id),
      values.commandId,
      values.expectedVersion,
    );
  }, true)(request);
}
