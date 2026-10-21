import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { ZodError } from "zod";
import { personas, workspaceId, type Actor } from "@loom/contracts";
import { DomainError } from "@loom/domain";
import { DatabaseError, DatabaseUnavailable } from "@loom/db-exasol";
const cookieName = "loom_demo_session";
const ttl = 8 * 60 * 60;
function sessionSecret() {
  const secret = process.env.LOOM_SESSION_SECRET;
  if (!secret || secret.length < 32)
    throw new DomainError(
      "SESSION_CONFIGURATION",
      "Set LOOM_SESSION_SECRET to at least 32 random characters before signing in.",
      503,
    );
  return secret;
}
function demoEnabled() {
  const origin = new URL(process.env.APP_ORIGIN || "http://localhost:3000");
  return (
    process.env.LOOM_AUTH_MODE === "local-demo" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) &&
    (process.env.NODE_ENV !== "production" ||
      process.env.LOOM_ALLOW_DEMO_PRODUCTION === "true")
  );
}
function sign(payload: string) {
  return createHmac("sha256", sessionSecret())
    .update(payload)
    .digest("base64url");
}
export async function actorFromCookie(): Promise<Actor | null> {
  if (!demoEnabled()) return null;
  const value = (await cookies()).get(cookieName)?.value;
  if (!value) return null;
  const [userId, issued, signature, ...extra] = value.split(".");
  if (
    extra.length ||
    !userId ||
    !issued ||
    !signature ||
    !personas.some((p) => p.id === userId)
  )
    return null;
  const stamp = Number(issued);
  if (
    !Number.isSafeInteger(stamp) ||
    stamp > Date.now() ||
    Date.now() - stamp > ttl * 1000
  )
    return null;
  const expected = sign(`${userId}.${issued}`);
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(signature) ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  )
    return null;
  return { userId, workspaceId };
}
export async function requireActor() {
  const actor = await actorFromCookie();
  if (!actor)
    throw new DomainError(
      "UNAUTHENTICATED",
      "Choose a local demo persona to continue.",
      401,
    );
  return actor;
}
export async function startSession(userId: string) {
  if (!demoEnabled())
    throw new DomainError(
      "DEMO_DISABLED",
      "Demo sign-in requires local-demo mode on a loopback origin. Production demo mode must be explicitly enabled.",
      403,
    );
  if (!personas.some((p) => p.id === userId))
    throw new DomainError(
      "INVALID_PERSONA",
      "Choose a known demo persona.",
      422,
    );
  const payload = `${userId}.${Date.now()}`;
  (await cookies()).set(cookieName, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.APP_ORIGIN?.startsWith("https:") ?? false,
    path: "/",
    maxAge: ttl,
  });
}
export async function endSession() {
  (await cookies()).delete(cookieName);
}
export function checkMutation(request: Request) {
  const expected = new URL(process.env.APP_ORIGIN || "http://localhost:3000")
    .origin;
  if (request.headers.get("origin") !== expected)
    throw new DomainError(
      "INVALID_ORIGIN",
      "This request came from an unexpected origin.",
      403,
    );
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new DomainError(
      "INVALID_CONTENT_TYPE",
      "Use application/json for this operation.",
      415,
    );
}
export async function jsonBody(request: Request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > 16_384)
    throw new DomainError("BODY_TOO_LARGE", "Request body is too large.", 413);
  if (!request.body)
    throw new DomainError("INVALID_JSON", "A JSON body is required.", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16_384) {
        await reader.cancel();
        throw new DomainError(
          "BODY_TOO_LARGE",
          "Request body is too large.",
          413,
        );
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("INVALID_JSON", "Enter valid JSON.", 400);
  } finally {
    reader.releaseLock();
  }
}
export function response(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store", Vary: "Cookie" },
  });
}
export function endpoint(
  fn: (request: Request) => Promise<unknown>,
  mutation = false,
) {
  return async (request: Request) => {
    const requestId = randomUUID();
    try {
      if (mutation) checkMutation(request);
      return response(await fn(request));
    } catch (error) {
      if (error instanceof ZodError)
        return response(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: error.issues
                .map((i) => `${i.path.join(".")}: ${i.message}`)
                .join("; "),
              requestId,
            },
          },
          422,
        );
      if (error instanceof DomainError)
        return response(
          { error: { code: error.code, message: error.message, requestId } },
          error.status,
        );
      if (error instanceof DatabaseUnavailable) {
        console.error(
          JSON.stringify({
            requestId,
            code: error.connectionCode || "DATABASE_UNAVAILABLE",
          }),
        );
        return response(
          {
            error: {
              code: "DATABASE_UNAVAILABLE",
              message: error.message,
              requestId,
            },
          },
          503,
        );
      }
      // Never serialize SQL, credentials, source text, or internal driver errors.
      console.error(
        JSON.stringify({
          requestId,
          code:
            error instanceof DatabaseError ? error.sqlCode : "INTERNAL_ERROR",
        }),
      );
      return response(
        {
          error: {
            code: "DATABASE_OPERATION_FAILED",
            message:
              "The operation could not be confirmed. Retry the same action to reconcile its saved result.",
            requestId,
          },
        },
        503,
      );
    }
  };
}
