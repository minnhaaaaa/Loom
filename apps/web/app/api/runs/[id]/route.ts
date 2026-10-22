import { z } from "zod";
import { runActionSchema } from "@loom/contracts";
import { changeRun, readRun } from "@/server/triage";
import { endpoint, jsonBody, requireActor } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  return endpoint(async () =>
    readRun(await requireActor(), z.uuid().parse((await context.params).id)),
  )(request);
}
export async function POST(request: Request, context: Context) {
  return endpoint(async () => {
    const actor = await requireActor(),
      id = z.uuid().parse((await context.params).id);
    const body = runActionSchema.parse(await jsonBody(request));
    return changeRun(
      actor,
      id,
      body.commandId,
      body.expectedVersion,
      body.action,
    );
  }, true)(request);
}
