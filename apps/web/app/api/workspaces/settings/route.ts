import { updateWorkspaceSettingsSchema } from "@loom/contracts";
import {
  readWorkspaceSettings,
  updateWorkspaceSettings,
} from "@/server/settings";
import { endpoint, jsonBody, requireActor } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = endpoint(async () =>
  readWorkspaceSettings(await requireActor()),
);
export const POST = endpoint(async (request) => {
  const actor = await requireActor();
  const values = updateWorkspaceSettingsSchema.parse(
    await jsonBody(request, 240_000),
  );
  return updateWorkspaceSettings(actor, values);
}, true);
