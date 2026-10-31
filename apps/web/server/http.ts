import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { ZodError } from "zod";
import { personas, workspaceId, type Actor } from "@loom/contracts";
import { DomainError } from "@loom/domain";
import { DatabaseError, DatabaseUnavailable } from "@loom/db-exasol";
import {
  accountContext,
  sessionActor,
  revokeSession,
  selectSessionWorkspace,
} from "./accounts";
import type { SessionGrant } from "@loom/contracts";
import { localDemoEnabled } from "./demo-mode";
const cookieName = "loom_demo_session";
const accountCookieName = "loom_session";
const ttl = 8 * 60 * 60;
const requestWorkspace = new AsyncLocalStorage<string | null>();
const unscopedPaths = new Set([
  "/api/account",
  "/api/account/login",
  "/api/account/register",
  "/api/session",
  "/api/workspaces/select",
  "/api/invitations/preview",
  "/api/invitations/accept",
]);
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
  return localDemoEnabled();
}
function sign(payload: string) {
  return createHmac("sha256", sessionSecret())
    .update(payload)
    .digest("base64url");
}
export function assertCredentialAuth() {
  const mode = process.env.LOOM_AUTH_MODE || "workspace";
  if (mode !== "workspace" && !(mode === "local-demo" && demoEnabled()))
    throw new DomainError(
      "AUTH_DISABLED",
      "Account sign-in is not enabled. Configure workspace authentication on the server.",
      403,
    );
  const origin = new URL(process.env.APP_ORIGIN || "http://localhost:3000");
  if (
    origin.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
  )
    throw new DomainError(
      "AUTH_CONFIGURATION",
      "Workspace authentication requires an HTTPS origin or loopback for local development.",
      503,
    );
  sessionSecret();
}
export async function actorFromCookie(): Promise<Actor | null> {
  const jar = await cookies();
  const accountToken = jar.get(accountCookieName)?.value;
  if (accountToken) {
    assertCredentialAuth();
    return sessionActor(accountToken);
  }
  if (!demoEnabled()) return null;
  const value = jar.get(cookieName)?.value;
  if (!value) return null;
  const parts = value.split(".");
  const scoped = parts[0] === "v2";
  const [userId, selectedWorkspaceId, issued, signature, ...extra] = scoped
    ? parts.slice(1)
    : [parts[0], workspaceId, ...parts.slice(1)];
  if (
    extra.length ||
    !userId ||
    !issued ||
    !signature ||
    !/^[0-9a-f-]{36}$/i.test(selectedWorkspaceId || "") ||
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
  const expected = sign(
    scoped
      ? `v2.${userId}.${selectedWorkspaceId}.${issued}`
      : `${userId}.${issued}`,
  );
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(signature) ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  )
    return null;
  return { userId, workspaceId: selectedWorkspaceId };
}
export async function requireActor() {
  const actor = await actorFromCookie();
  if (!actor)
    throw new DomainError("UNAUTHENTICATED", "Sign in to continue.", 401);
  const expectedWorkspace = requestWorkspace.getStore();
  if (expectedWorkspace && expectedWorkspace !== actor.workspaceId)
    throw new DomainError(
      "WORKSPACE_CHANGED",
      "Your active company changed in another tab. Reload this workspace before continuing.",
      409,
    );
  return actor;
}
export async function startSession(
  userId: string,
  selectedWorkspaceId = workspaceId,
) {
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
  const payload = `v2.${userId}.${selectedWorkspaceId}.${Date.now()}`;
  const signed = `${payload}.${sign(payload)}`;
  await endSession();
  (await cookies()).set(cookieName, signed, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.APP_ORIGIN?.startsWith("https:") ?? false,
    path: "/",
    maxAge: ttl,
  });
}
export async function endSession() {
  const jar = await cookies();
  const token = jar.get(accountCookieName)?.value;
  if (token) await revokeSession(token);
  jar.delete(accountCookieName);
  jar.delete(cookieName);
}
export async function installAccountSession(grant: SessionGrant) {
  const jar = await cookies();
  const oldToken = jar.get(accountCookieName)?.value;
  if (oldToken && oldToken !== grant.token) await revokeSession(oldToken);
  jar.set(accountCookieName, grant.token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.APP_ORIGIN?.startsWith("https:") ?? false,
    path: "/",
    maxAge: ttl,
  });
  jar.delete(cookieName);
}
export async function currentAccount() {
  const context = await accountContext(await actorFromCookie());
  let enabled = false;
  try {
    assertCredentialAuth();
    enabled = true;
  } catch {
    /* Configuration remains private; mutations provide actionable errors. */
  }
  return {
    ...context,
    registrationEnabled: context.registrationEnabled && enabled,
  };
}
export async function switchWorkspace(id: string) {
  const actor = await requireActor();
  const jar = await cookies();
  const token = jar.get(accountCookieName)?.value;
  if (token) return selectSessionWorkspace(token, id);
  const context = await accountContext(actor);
  if (!context.workspaces.some((workspace) => workspace.id === id))
    throw new DomainError(
      "ACCESS_DENIED",
      "You do not have access to this workspace.",
      403,
    );
  await startSession(actor.userId, id);
  return { ...actor, workspaceId: id };
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
export async function jsonBody(request: Request, maxBytes = 16_384) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > maxBytes)
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
      if (size > maxBytes) {
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
      const expectedWorkspace = unscopedPaths.has(new URL(request.url).pathname)
        ? null
        : request.headers.get("x-loom-workspace");
      // Optional for API/MCP compatibility. Browser calls bind their rendered
      // company; requireActor checks it every time it resolves the session.
      const result = await requestWorkspace.run(expectedWorkspace, () =>
        fn(request),
      );
      return result instanceof Response ? result : response(result);
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
      if (error instanceof DomainError) {
        const result = response(
          {
            error: {
              code: error.code,
              message: error.message,
              requestId,
              ...error.details,
            },
          },
          error.status,
        );
        if (error.details?.retryAfterSeconds)
          result.headers.set(
            "Retry-After",
            String(error.details.retryAfterSeconds),
          );
        return result;
      }
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
