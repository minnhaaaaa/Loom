import { z } from "zod";
import { acceptInvitationSchema } from "@loom/contracts";
import { acceptInvitation } from "@/server/workspaces";
import {
  actorFromCookie,
  assertCredentialAuth,
  endpoint,
  installAccountSession,
  jsonBody,
  requireActor,
} from "@/server/http";
import { limitCredentialAttempt } from "@/server/auth-limits";
export const runtime = "nodejs";
const token = z.string().min(32).max(200);
const schema = z.union([
  acceptInvitationSchema.extend({ token }),
  z.object({ token }).strict(),
]);
export const POST = endpoint(async (request) => {
  assertCredentialAuth();
  const values = schema.parse(await jsonBody(request));
  limitCredentialAttempt(`accept:${values.token}`);
  const actor = await actorFromCookie();
  const grant = await acceptInvitation(
    values.token,
    "email" in values
      ? { name: values.name, email: values.email, password: values.password }
      : (actor || (await requireActor())).userId,
  );
  await installAccountSession(grant);
  return { ok: true };
}, true);
