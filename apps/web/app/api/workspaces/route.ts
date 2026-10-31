import { createWorkspaceSchema } from "@loom/contracts";
import { createWorkspace } from "@/server/workspaces";
import {
  endpoint,
  jsonBody,
  requireActor,
  switchWorkspace,
} from "@/server/http";
export const runtime = "nodejs";
export const POST = endpoint(async (request) => {
  const actor = await requireActor();
  const values = createWorkspaceSchema.parse(await jsonBody(request));
  const workspace = await createWorkspace(actor, values.commandId, values.name);
  await switchWorkspace(workspace.id);
  return workspace;
}, true);
