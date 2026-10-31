import { z } from "zod";
import { cookies } from "next/headers";
import { DomainError } from "@loom/domain";
import { endpoint, requireActor, jsonBody } from "@/server/http";
import {
  OPENAI_TRANSACTION_TTL,
  assertOpenAiLocalRequest,
} from "@/server/openai-oauth";
import { startOpenAiConnection } from "@/server/openai-oauth-store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = endpoint(async (request) => {
  assertOpenAiLocalRequest(request);
  const selection = z
    .object({
      clientId: z.string().max(220).optional(),
      newAccount: z.boolean().optional(),
    })
    .strict()
    .parse(await jsonBody(request));
  const actor = await requireActor();
  if (request.headers.get("x-loom-workspace") !== actor.workspaceId)
    throw new DomainError(
      "WORKSPACE_CHANGED",
      "Reload the current company before connecting ChatGPT.",
      409,
    );
  const jar = await cookies();
  const pending = await startOpenAiConnection(
    actor,
    jar.get("loom_session")?.value,
    selection,
  );
  jar.set("loom_openai_oauth", pending.browserToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: pending.secure,
    path: "/api/oauth/openai/callback",
    maxAge: OPENAI_TRANSACTION_TTL / 1000,
  });
  return { authorizationUrl: pending.authorizationUrl };
}, true);
