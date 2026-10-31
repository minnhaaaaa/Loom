import { loginAccountSchema } from "@loom/contracts";
import { loginAccount } from "@/server/accounts";
import {
  assertCredentialAuth,
  endpoint,
  installAccountSession,
  jsonBody,
} from "@/server/http";
import { limitCredentialAttempt } from "@/server/auth-limits";
export const runtime = "nodejs";
export const POST = endpoint(async (request) => {
  assertCredentialAuth();
  const values = loginAccountSchema.parse(await jsonBody(request));
  limitCredentialAttempt(values.email);
  await installAccountSession(await loginAccount(values));
  return { ok: true };
}, true);
