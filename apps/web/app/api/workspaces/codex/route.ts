import { z } from "zod";
import { assertOpenAiLocalRequest } from "@/server/openai-oauth";
import { DomainError } from "@loom/domain";
import { endpoint, requireActor, jsonBody } from "@/server/http";
import {
  readOpenAiConnection,
  disconnectOpenAiIdentity,
  updateOpenAiModel,
} from "@/server/openai-oauth-store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function scopedActor(request: Request) {
  const actor = await requireActor();
  if (request.headers.get("x-loom-workspace") !== actor.workspaceId)
    throw new DomainError(
      "WORKSPACE_CHANGED",
      "Reload the current company before managing ChatGPT sign-in.",
      409,
    );
  return actor;
}
export const GET = endpoint(async (request) =>
  readOpenAiConnection(await scopedActor(request)),
);
export const PATCH = endpoint(async (request) => {
  assertOpenAiLocalRequest(request);
  const actor = await scopedActor(request);
  const input = z
    .object({ model: z.string() })
    .strict()
    .parse(await jsonBody(request));
  return updateOpenAiModel(actor, input.model);
}, true);
export const DELETE = endpoint(async (request) => {
  assertOpenAiLocalRequest(request);
  return disconnectOpenAiIdentity(await scopedActor(request));
}, true);
