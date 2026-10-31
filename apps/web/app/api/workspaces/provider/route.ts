import { providerSettingsInputSchema } from "@loom/contracts";
import { DomainError } from "@loom/domain";
import { endpoint, jsonBody, requireActor } from "@/server/http";
import {
  readProviderSettings,
  updateProviderSettings,
} from "@/server/provider-config";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function scopedActor(request: Request) {
  const actor = await requireActor();
  if (request.headers.get("x-loom-workspace") !== actor.workspaceId)
    throw new DomainError(
      "WORKSPACE_CHANGED",
      "Your active company changed. Reload its AI settings before continuing.",
      409,
    );
  return actor;
}
export const GET = endpoint(async (request) =>
  readProviderSettings(await scopedActor(request)),
);
export const POST = endpoint(
  async (request) =>
    updateProviderSettings(
      await scopedActor(request),
      providerSettingsInputSchema.parse(await jsonBody(request, 12_000)),
    ),
  true,
);
