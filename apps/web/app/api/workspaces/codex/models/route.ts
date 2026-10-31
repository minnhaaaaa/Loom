import { DomainError } from "@loom/domain";
import { readDatabase } from "@loom/db-exasol";
import { endpoint, requireActor } from "@/server/http";
import { assertOpenAiLocalRequest } from "@/server/openai-oauth";
import {
  assertOpenAiPlanCurrent,
  getOpenAiPlanCredential,
} from "@/server/openai-oauth-store";
import { fetchModelCatalog } from "@/server/model-catalog";
import { limitCredentialAttempt } from "@/server/auth-limits";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = endpoint(async (request) => {
  assertOpenAiLocalRequest(request);
  const actor = await requireActor();
  if (request.headers.get("x-loom-workspace") !== actor.workspaceId)
    throw new DomainError(
      "WORKSPACE_CHANGED",
      "Reload the current company before loading models.",
      409,
    );
  const credential = await getOpenAiPlanCredential(actor);
  if (!credential)
    throw new DomainError(
      "OPENAI_PLAN_NOT_AUTHORIZED",
      "Connect ChatGPT to load your models.",
      403,
    );
  limitCredentialAttempt(`models:${actor.workspaceId}:${actor.userId}`);
  const models = await fetchModelCatalog(
    "openai",
    credential.accessToken,
    true,
  );
  await readDatabase((sql) => assertOpenAiPlanCurrent(sql, actor, credential));
  return { models };
});
