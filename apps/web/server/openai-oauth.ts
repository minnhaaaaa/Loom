import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { DomainError } from "@loom/domain";

export const OPENAI_ISSUER = "https://auth.openai.com";
export const OPENAI_CALLBACK_PATH = "/api/oauth/openai/callback";
export const OPENAI_SETUP_URL =
  "https://developers.openai.com/siwc/token-sharing-open-source/sign-in";
export const OPENAI_RESOURCE = "https://api.openai.com/v1";
export const OPENAI_PLAN_SCOPES = [
  "offline_access",
  "resource.invoke",
  "chatgpt.tokens.use.direct",
] as const;
export const OPENAI_TRANSACTION_TTL = 10 * 60_000;
const discoveryUrl = `${OPENAI_ISSUER}/.well-known/openid-configuration`;
export type OpenAiOAuthConfig = {
  origin: string;
  redirectUri: string;
};
export type OpenAiMetadata = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  revocationEndpoint: string;
  algorithms: string[];
};
export type OpenAiTransaction = {
  state: string;
  verifier: string;
  challenge: string;
  nonce: string;
  clientId: string;
  redirectUri: string;
  hostId: string;
  expectedSubject: string | null;
  expiresAt: number;
};
export type OpenAiIdentity = {
  issuer: string;
  clientId: string;
  subject: string;
  email: string | null;
  name: string | null;
};
function fail(
  message = "ChatGPT sign-in could not be verified. Start a new connection attempt.",
) {
  return new DomainError("OPENAI_OAUTH_FAILED", message, 400);
}
export function openAiOAuthConfig(env = process.env): OpenAiOAuthConfig | null {
  if (env.LOOM_OPENAI_LOCAL_ENABLED !== "true") return null;
  try {
    const origin = new URL(env.APP_ORIGIN || "");
    if (
      origin.protocol !== "http:" ||
      origin.hostname !== "127.0.0.1" ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== "/"
    )
      throw new Error();
    if (!/^[a-fA-F0-9]{64}$/.test(env.LOOM_PROVIDER_ENCRYPTION_KEY || ""))
      throw new Error();
    return {
      origin: origin.origin,
      redirectUri: origin.origin + OPENAI_CALLBACK_PATH,
    };
  } catch {
    throw new DomainError(
      "OPENAI_OAUTH_NOT_CONFIGURED",
      "Local ChatGPT connection requires APP_ORIGIN=http://127.0.0.1:<port> and a configured credential encryption key.",
      503,
    );
  }
}
export function requireOpenAiOAuthConfig() {
  const config = openAiOAuthConfig();
  if (!config)
    throw new DomainError(
      "OPENAI_OAUTH_NOT_CONFIGURED",
      "Enable LOOM_OPENAI_LOCAL_ENABLED for the local ChatGPT connection.",
      503,
    );
  return config;
}
export function assertOpenAiLocalRequest(request: Request) {
  const config = requireOpenAiOAuthConfig();
  const canonical = new URL(config.origin);
  const incoming = new URL(request.url);
  // NextRequest rewrites loopback URL hostnames to localhost. The actual Host
  // header retains the browser's address; forwarded headers are not authority.
  if (
    request.headers.get("host") !== canonical.host ||
    incoming.protocol !== canonical.protocol ||
    incoming.port !== canonical.port ||
    ![canonical.hostname, "localhost"].includes(incoming.hostname)
  )
    throw new DomainError(
      "OPENAI_CANONICAL_ORIGIN",
      "Open Loom at its 127.0.0.1 address and sign in there before connecting ChatGPT.",
      409,
    );
  return config;
}
export function openAiLocalRequestUrl(request: Request): URL {
  const config = assertOpenAiLocalRequest(request);
  const url = new URL(request.url);
  // Restore only the verified host. Preserve the callback path and query so
  // the existing exact-path, state, issued-client and one-use checks still run.
  url.host = new URL(config.origin).host;
  return url;
}
export function hasOpenAiPlanScope(scopes: readonly string[]) {
  return OPENAI_PLAN_SCOPES.every((scope) => scopes.includes(scope));
}
export type OpenAiTokens = {
  idToken: string;
  accessToken: string | null;
  refreshToken: string | null;
  scopes: string[];
  expiresAt: number;
  earliestRefreshAt: number;
  nonce: string;
};
export function parseOpenAiTokens(
  body: Record<string, unknown>,
  nonce: string,
  previous?: OpenAiTokens,
): OpenAiTokens {
  const idToken =
    typeof body.id_token === "string" ? body.id_token : previous?.idToken;
  if (!idToken || idToken.length > 32768) throw fail();
  const scopes =
    typeof body.scope === "string"
      ? [...new Set(body.scope.split(/\s+/).filter(Boolean))]
      : (previous?.scopes ?? []);
  const accessToken =
    typeof body.access_token === "string" && body.access_token.length <= 32768
      ? body.access_token
      : null;
  const refreshToken =
    typeof body.refresh_token === "string" && body.refresh_token.length <= 32768
      ? body.refresh_token
      : null;
  const expires = Number(body.expires_in);
  if (
    accessToken &&
    (String(body.token_type).toLowerCase() !== "bearer" ||
      !Number.isFinite(expires) ||
      expires <= 0 ||
      expires > 86400)
  )
    throw fail();
  if (hasOpenAiPlanScope(scopes) && (!accessToken || !refreshToken))
    throw fail();
  let earliest =
    typeof body.earliest_refresh_at === "number"
      ? body.earliest_refresh_at * (body.earliest_refresh_at < 1e12 ? 1000 : 1)
      : typeof body.earliest_refresh_at === "string"
        ? Date.parse(body.earliest_refresh_at)
        : 0;
  if (!Number.isFinite(earliest)) earliest = 0;
  return {
    idToken,
    accessToken,
    refreshToken,
    scopes,
    expiresAt: accessToken ? Date.now() + expires * 1000 : 0,
    earliestRefreshAt: earliest,
    nonce,
  };
}
export function oauthDigest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export function equalOAuthSecret(left: string, right: string) {
  return timingSafeEqual(
    createHash("sha256").update(left).digest(),
    createHash("sha256").update(right).digest(),
  );
}
export function createOpenAiTransaction(
  config: OpenAiOAuthConfig,
  hostId: string,
  registration?: { clientId: string; subject: string | null },
  now = Date.now(),
): OpenAiTransaction {
  const verifier = randomBytes(64).toString("base64url");
  return {
    state: randomBytes(32).toString("base64url"),
    nonce: randomBytes(32).toString("base64url"),
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    clientId: registration?.clientId ?? "dynamic_agent_client",
    expectedSubject: registration?.subject ?? null,
    redirectUri: config.redirectUri,
    hostId,
    expiresAt: now + OPENAI_TRANSACTION_TTL,
  };
}
async function readJson(response: Response): Promise<Record<string, unknown>> {
  if (
    !response.ok ||
    Number(response.headers.get("content-length") || 0) > 65_536 ||
    !response.body
  )
    throw fail();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > 65_536) {
        await reader.cancel();
        throw fail();
      }
      chunks.push(next.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw fail();
    return value as Record<string, unknown>;
  } finally {
    reader.releaseLock();
  }
}
function trustedEndpoint(value: unknown): string {
  if (typeof value !== "string") throw fail();
  const url = new URL(value);
  if (
    url.origin !== OPENAI_ISSUER ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw fail();
  return url.href;
}
let metadataCache: { value: OpenAiMetadata; expiresAt: number } | undefined;
export async function discoverOpenAi(
  fetcher: typeof fetch = fetch,
): Promise<OpenAiMetadata> {
  if (
    fetcher === fetch &&
    metadataCache &&
    metadataCache.expiresAt > Date.now()
  )
    return metadataCache.value;
  try {
    const body = await readJson(
      await fetcher(discoveryUrl, {
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      }),
    );
    if (body.issuer !== OPENAI_ISSUER) throw fail();
    const algorithms = Array.isArray(body.id_token_signing_alg_values_supported)
      ? body.id_token_signing_alg_values_supported.filter(
          (algorithm): algorithm is string =>
            algorithm === "RS256" || algorithm === "ES256",
        )
      : [];
    if (!algorithms.length) throw fail();
    const value = {
      issuer: OPENAI_ISSUER,
      authorizationEndpoint: trustedEndpoint(body.authorization_endpoint),
      tokenEndpoint: trustedEndpoint(body.token_endpoint),
      jwksUri: trustedEndpoint(body.jwks_uri),
      revocationEndpoint: trustedEndpoint(body.revocation_endpoint),
      algorithms,
    };
    if (fetcher === fetch)
      metadataCache = { value, expiresAt: Date.now() + 60 * 60_000 };
    return value;
  } catch {
    throw new DomainError(
      "OPENAI_OAUTH_UNAVAILABLE",
      "OpenAI sign-in is temporarily unavailable. Try again later.",
      503,
    );
  }
}
export function openAiAuthorizationUrl(
  metadata: OpenAiMetadata,
  transaction: OpenAiTransaction,
) {
  const url = new URL(metadata.authorizationEndpoint);
  url.search = new URLSearchParams({
    client_id: transaction.clientId,
    redirect_uri: transaction.redirectUri,
    response_type: "code",
    scope: `openid profile email ${OPENAI_PLAN_SCOPES.join(" ")}`,
    resource: OPENAI_RESOURCE,
    ext_agent_host_id: transaction.hostId,
    state: transaction.state,
    nonce: transaction.nonce,
    code_challenge: transaction.challenge,
    code_challenge_method: "S256",
    ...(transaction.clientId === "dynamic_agent_client"
      ? { agent_name_hint: "Loom" }
      : {}),
  }).toString();
  // Retained ID tokens stay encrypted server-side; omitting the optional hint
  // avoids exposing them in application JSON or authorization URL diagnostics.
  return url.href;
}
export function validateOpenAiCallback(
  url: URL,
  transaction: OpenAiTransaction,
  config: OpenAiOAuthConfig,
  now = Date.now(),
) {
  if (
    url.origin + url.pathname !== config.redirectUri ||
    transaction.expiresAt <= now ||
    transaction.redirectUri !== config.redirectUri ||
    url.searchParams.getAll("state").length !== 1 ||
    !equalOAuthSecret(url.searchParams.get("state") || "", transaction.state)
  )
    throw fail();
  if (url.searchParams.has("error"))
    throw new DomainError(
      "OPENAI_OAUTH_DECLINED",
      "ChatGPT sign-in was not completed. You can try again when ready.",
      400,
    );
  const code = url.searchParams.get("code"),
    returnedId = url.searchParams.get("client_id");
  if (
    !code ||
    code.length > 4096 ||
    url.searchParams.getAll("code").length !== 1 ||
    url.searchParams.getAll("client_id").length > 1
  )
    throw fail();
  const clientId =
    returnedId ||
    (transaction.clientId !== "dynamic_agent_client"
      ? transaction.clientId
      : "");
  if (
    !/^oaiapp_[A-Za-z0-9_-]{6,200}$/.test(clientId) ||
    (transaction.clientId !== "dynamic_agent_client" &&
      clientId !== transaction.clientId)
  )
    throw fail();
  return { code, clientId };
}
const keySets = new Map<string, JWTVerifyGetKey>();
export function openAiKeySet(metadata: OpenAiMetadata) {
  let keys = keySets.get(metadata.jwksUri);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(metadata.jwksUri), {
      timeoutDuration: 10_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
    keySets.set(metadata.jwksUri, keys);
  }
  return keys;
}
export async function verifyOpenAiIdentity(
  idToken: string,
  clientId: string,
  metadata: OpenAiMetadata,
  nonce: string,
  keys: JWTVerifyGetKey = openAiKeySet(metadata),
  refreshing = false,
): Promise<OpenAiIdentity> {
  try {
    const { payload } = await jwtVerify(idToken, keys, {
      issuer: OPENAI_ISSUER,
      audience: clientId,
      algorithms: metadata.algorithms,
      requiredClaims: ["sub", "exp", "iat", ...(refreshing ? [] : ["nonce"])],
      clockTolerance: 5,
    });
    if (
      ((!refreshing || payload.nonce !== undefined) &&
        (typeof payload.nonce !== "string" ||
          !equalOAuthSecret(payload.nonce, nonce))) ||
      typeof payload.sub !== "string" ||
      !payload.sub ||
      payload.sub.length > 512 ||
      !payload.iat ||
      payload.iat > Date.now() / 1000 + 5
    )
      throw fail();
    if (
      (payload.azp !== undefined && payload.azp !== clientId) ||
      (Array.isArray(payload.aud) &&
        payload.aud.length > 1 &&
        payload.azp !== clientId)
    )
      throw fail();
    return {
      issuer: OPENAI_ISSUER,
      clientId,
      subject: payload.sub,
      email:
        payload.email_verified === true &&
        typeof payload.email === "string" &&
        payload.email.length <= 320
          ? payload.email
          : null,
      name:
        typeof payload.name === "string" && payload.name.length <= 160
          ? payload.name
          : null,
    };
  } catch {
    throw fail();
  }
}
export async function exchangeOpenAiCode(
  code: string,
  clientId: string,
  transaction: OpenAiTransaction,
  metadata: OpenAiMetadata,
  fetcher: typeof fetch = fetch,
  keys?: JWTVerifyGetKey,
) {
  try {
    const body = await readJson(
      await fetcher(metadata.tokenEndpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          redirect_uri: transaction.redirectUri,
          code_verifier: transaction.verifier,
          resource: OPENAI_RESOURCE,
        }),
      }),
    );
    const tokens = parseOpenAiTokens(body, transaction.nonce);
    const identity = await verifyOpenAiIdentity(
      tokens.idToken,
      clientId,
      metadata,
      transaction.nonce,
      keys,
    );
    if (
      transaction.expectedSubject &&
      identity.subject !== transaction.expectedSubject
    )
      throw fail();
    return { identity, tokens };
  } catch {
    throw fail();
  }
}
export async function refreshOpenAiTokens(
  clientId: string,
  subject: string,
  previous: OpenAiTokens,
  metadata: OpenAiMetadata,
  fetcher: typeof fetch = fetch,
  keys?: JWTVerifyGetKey,
) {
  if (!previous.refreshToken)
    throw new DomainError(
      "OPENAI_RECONNECT_REQUIRED",
      "Reconnect your ChatGPT account to continue.",
      401,
    );
  let response: Response;
  try {
    response = await fetcher(metadata.tokenEndpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: previous.refreshToken,
        resource: OPENAI_RESOURCE,
      }),
    });
  } catch {
    throw new DomainError(
      "OPENAI_REFRESH_UNAVAILABLE",
      "ChatGPT renewal is temporarily unavailable. Try again shortly.",
      503,
    );
  }
  if (!response.ok) {
    let code = "";
    try {
      const body = await readJson(
        new Response(response.body, { headers: response.headers, status: 200 }),
      );
      code = typeof body.error === "string" ? body.error : "";
    } catch {
      /* no credential-bearing error is surfaced */
    }
    const terminal = [
      "invalid_grant",
      "invalid_refresh_token",
      "token_expired",
      "refresh_token_expired",
      "refresh_token_invalidated",
      "refresh_token_invalid",
      "refresh_token_reused",
    ].includes(code);
    throw new DomainError(
      terminal ? "OPENAI_RECONNECT_REQUIRED" : "OPENAI_REFRESH_UNAVAILABLE",
      terminal
        ? "Reconnect your ChatGPT account to continue."
        : "ChatGPT renewal is temporarily unavailable. Try again shortly.",
      terminal ? 401 : 503,
    );
  }
  try {
    const body = await readJson(response),
      tokens = parseOpenAiTokens(body, previous.nonce, previous);
    if (body.id_token) {
      const identity = await verifyOpenAiIdentity(
        tokens.idToken,
        clientId,
        metadata,
        previous.nonce,
        keys,
        true,
      );
      if (identity.subject !== subject)
        throw new DomainError(
          "OPENAI_RECONNECT_REQUIRED",
          "ChatGPT identity changed. Reconnect your account.",
          401,
        );
    }
    return tokens;
  } catch {
    // A successful refresh may already have rotated the token. Never reuse the
    // old credential after an unverifiable replacement response.
    throw new DomainError(
      "OPENAI_RECONNECT_REQUIRED",
      "ChatGPT returned credentials that could not be verified. Reconnect your account.",
      401,
    );
  }
}
export async function revokeOpenAiTokens(
  clientId: string,
  refreshToken: string,
  metadata: OpenAiMetadata,
  fetcher: typeof fetch = fetch,
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetcher(metadata.revocationEndpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(8000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: refreshToken,
          token_type_hint: "refresh_token",
          client_id: clientId,
        }),
      });
      if (response.status === 200) return true;
      if (response.status < 500) return false;
    } catch {
      /* one bounded retry; keep secrets out of errors */
    }
    if (!attempt) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}
