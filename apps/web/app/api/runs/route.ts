import { runStartSchema } from "@loom/contracts";
import { listRuns, startRun } from "@/server/triage";
import { endpoint, jsonBody, requireActor } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = endpoint(async () => listRuns(await requireActor()));
export const POST = endpoint(async (request) => {
  const actor = await requireActor();
  const body = runStartSchema.parse(await jsonBody(request));
  return startRun(actor, body.commandId, body.requestIds, body.instructions);
}, true);
