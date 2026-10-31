import { registerAccountSchema } from "@loom/contracts";
import { registerAccount } from "@/server/accounts";
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
  const values = registerAccountSchema.parse(await jsonBody(request));
  limitCredentialAttempt(values.email);
  await installAccountSession(await registerAccount(values));
  return { ok: true };
}, true);
