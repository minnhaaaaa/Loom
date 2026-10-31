import { providerModelsInputSchema } from "@loom/contracts";
import { DomainError } from "@loom/domain";
import { endpoint, jsonBody, requireActor } from "@/server/http";
import { listCompanyModels } from "@/server/provider-config";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = endpoint(async (request) => {
  const actor = await requireActor();
  if (request.headers.get("x-loom-workspace") !== actor.workspaceId)
    throw new DomainError(
      "WORKSPACE_CHANGED",
      "Reload the current company before loading models.",
      409,
    );
  return listCompanyModels(
    actor,
    providerModelsInputSchema.parse(await jsonBody(request, 6000)),
  );
}, true);
