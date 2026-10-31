import { z } from "zod";
import { invitationPreview } from "@/server/workspaces";
import { assertCredentialAuth, endpoint, jsonBody } from "@/server/http";
import { limitCredentialAttempt } from "@/server/auth-limits";
export const runtime = "nodejs";
export const POST = endpoint(async (request) => {
  assertCredentialAuth();
  const { token } = z
    .object({ token: z.string().min(32).max(200) })
    .strict()
    .parse(await jsonBody(request));
  limitCredentialAttempt(`preview:${token}`);
  return invitationPreview(token);
}, true);
