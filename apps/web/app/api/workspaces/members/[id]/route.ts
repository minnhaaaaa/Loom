import { z } from "zod";
import { changeMembershipSchema } from "@loom/contracts";
import { changeMembership } from "@/server/workspaces";
import { endpoint, jsonBody, requireActor } from "@/server/http";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return endpoint(async (request) => {
    const actor = await requireActor();
    const values = changeMembershipSchema.parse(await jsonBody(request));
    return changeMembership(
      actor,
      z.uuid().parse(id),
      values.commandId,
      values.expectedVersion,
      values.role,
      values.active,
    );
  }, true)(request);
}
