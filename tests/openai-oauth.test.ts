import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  OPENAI_ISSUER,
  OPENAI_RESOURCE,
  OPENAI_PLAN_SCOPES,
  assertOpenAiLocalRequest,
  createOpenAiTransaction,
  discoverOpenAi,
  exchangeOpenAiCode,
  hasOpenAiPlanScope,
  openAiAuthorizationUrl,
  openAiOAuthConfig,
  openAiLocalRequestUrl,
  parseOpenAiTokens,
  refreshOpenAiTokens,
  validateOpenAiCallback,
  verifyOpenAiIdentity,
  type OpenAiMetadata,
} from "../apps/web/server/openai-oauth";
const config = {
  origin: "http://127.0.0.1:3000",
  redirectUri: "http://127.0.0.1:3000/api/oauth/openai/callback",
};
const clientId = "oaiapp_syntheticfixture";
const hostId = "urn:uuid:11111111-1111-4111-8111-111111111111";
const metadata: OpenAiMetadata = {
  issuer: OPENAI_ISSUER,
  authorizationEndpoint: `${OPENAI_ISSUER}/api/accounts/authorize`,
  tokenEndpoint: `${OPENAI_ISSUER}/api/accounts/oauth/token`,
  jwksUri: `${OPENAI_ISSUER}/.well-known/jwks.json`,
  revocationEndpoint: `${OPENAI_ISSUER}/oauth/revoke`,
  algorithms: ["RS256"],
};
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
afterEach(() => vi.unstubAllEnvs());
function jwt(nonce: string, changes: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: OPENAI_ISSUER,
    aud: clientId,
    sub: "synthetic-subject",
    exp: now + 300,
    iat: now,
    nonce,
    email: "fixture@example.test",
    email_verified: true,
    name: "Fixture",
    ...changes,
  };
  const input = `${Buffer.from(JSON.stringify({ alg: "RS256", kid: "test" })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), pair.privateKey).toString("base64url")}`;
}
const keys = async () => pair.publicKey;
function body(idToken: string, overrides: Record<string, unknown> = {}) {
  return {
    id_token: idToken,
    access_token: "synthetic-access",
    refresh_token: "synthetic-refresh",
    token_type: "Bearer",
    expires_in: 3600,
    scope: `openid profile email ${OPENAI_PLAN_SCOPES.join(" ")}`,
    ...overrides,
  };
}
it("requires explicit local enablement, canonical 127.0.0.1 and encrypted storage", () => {
  const env = {
    LOOM_OPENAI_LOCAL_ENABLED: "true",
    APP_ORIGIN: config.origin,
    LOOM_PROVIDER_ENCRYPTION_KEY: "a".repeat(64),
  };
  expect(openAiOAuthConfig({})).toBeNull();
  expect(openAiOAuthConfig(env)).toEqual(config);
  for (const origin of [
    "http://localhost:3000",
    "https://example.com",
    "http://127.0.0.1:3000/extra",
  ])
    expect(() => openAiOAuthConfig({ ...env, APP_ORIGIN: origin })).toThrow();
  expect(() =>
    openAiOAuthConfig({ ...env, LOOM_PROVIDER_ENCRYPTION_KEY: "" }),
  ).toThrow();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  expect(() =>
    assertOpenAiLocalRequest(
      new Request("http://localhost:3000/api/workspaces/codex/start"),
    ),
  ).toThrow();
  expect(
    assertOpenAiLocalRequest(
      new Request(config.origin, {
        headers: { host: new URL(config.origin).host },
      }),
    ),
  ).toEqual(config);
});
it("uses the actual canonical Host when Next normalizes its request URL, including callbacks", () => {
  vi.stubEnv("LOOM_OPENAI_LOCAL_ENABLED", "true");
  vi.stubEnv("APP_ORIGIN", config.origin);
  vi.stubEnv("LOOM_PROVIDER_ENCRYPTION_KEY", "a".repeat(64));
  const transaction = createOpenAiTransaction(config, hostId);
  const request = new Request(
    `http://localhost:3000/api/oauth/openai/callback?code=fixture&state=${transaction.state}&client_id=${clientId}`,
    { headers: { host: "127.0.0.1:3000" } },
  );
  expect(assertOpenAiLocalRequest(request)).toEqual(config);
  const restored = openAiLocalRequestUrl(request);
  expect(restored.origin).toBe(config.origin);
  expect(restored.search).toBe(new URL(request.url).search);
  expect(validateOpenAiCallback(restored, transaction, config)).toEqual({
    code: "fixture",
    clientId,
  });
  restored.pathname = "/another-callback";
  expect(() => validateOpenAiCallback(restored, transaction, config)).toThrow();
});
it.each([
  "localhost:3000",
  "127.0.0.1:4000",
  "example.com",
  "127.0.0.1:3000, example.com",
  "",
])(
  "rejects noncanonical Host %j even with canonical-looking URL and forwarded headers",
  (host) => {
    vi.stubEnv("LOOM_OPENAI_LOCAL_ENABLED", "true");
    vi.stubEnv("APP_ORIGIN", config.origin);
    vi.stubEnv("LOOM_PROVIDER_ENCRYPTION_KEY", "a".repeat(64));
    expect(() =>
      openAiLocalRequestUrl(
        new Request(config.redirectUri, {
          headers: {
            host,
            "x-forwarded-host": "127.0.0.1:3000",
            "x-forwarded-proto": "http",
          },
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "OPENAI_CANONICAL_ORIGIN" }));
  },
);
it("generates independent S256 PKCE/state/nonce and only dynamically registers a new client", () => {
  const first = createOpenAiTransaction(config, hostId),
    second = createOpenAiTransaction(config, hostId);
  expect(first.state).not.toBe(second.state);
  expect(first.nonce).not.toBe(second.nonce);
  expect(first.challenge).toBe(
    createHash("sha256").update(first.verifier).digest("base64url"),
  );
  const url = new URL(openAiAuthorizationUrl(metadata, first));
  expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
  expect(url.searchParams.get("agent_name_hint")).toBe("Loom");
  expect(url.searchParams.get("ext_agent_host_id")).toBe(hostId);
  expect(url.searchParams.get("resource")).toBe(OPENAI_RESOURCE);
  expect(url.searchParams.get("scope")?.split(" ")).toEqual(
    expect.arrayContaining([...OPENAI_PLAN_SCOPES]),
  );
  expect(url.searchParams.has("code_verifier")).toBe(false);
  const returning = new URL(
    openAiAuthorizationUrl(
      metadata,
      createOpenAiTransaction(config, hostId, {
        clientId,
        subject: "synthetic-subject",
      }),
    ),
  );
  expect(returning.searchParams.get("client_id")).toBe(clientId);
  expect(returning.searchParams.has("agent_name_hint")).toBe(false);
});
it("asks for plan consent only on an explicit enable action and keeps the saved registration", () => {
  const transaction = createOpenAiTransaction(config, hostId, {
    clientId,
    subject: "synthetic-subject",
  });
  const ordinary = new URL(openAiAuthorizationUrl(metadata, transaction));
  const enable = new URL(
    openAiAuthorizationUrl(metadata, transaction, { requestPlanAccess: true }),
  );
  expect(ordinary.searchParams.has("prompt")).toBe(false);
  expect(enable.searchParams.get("prompt")).toBe("consent");
  expect(enable.searchParams.get("client_id")).toBe(clientId);
  expect(enable.searchParams.get("scope")?.split(" ")).toEqual(
    expect.arrayContaining([...OPENAI_PLAN_SCOPES]),
  );
  expect(enable.searchParams.has("force_reconsent")).toBe(false);
});
it("validates state, expiry, origin, OAuth errors and the issued client binding before exchange", () => {
  const transaction = createOpenAiTransaction(config, hostId);
  const url = new URL(
    `${config.redirectUri}?code=fixture&state=${transaction.state}&client_id=${clientId}`,
  );
  expect(validateOpenAiCallback(url, transaction, config)).toEqual({
    code: "fixture",
    clientId,
  });
  for (const alter of [
    (u: URL) => u.searchParams.set("state", "forged"),
    (u: URL) => u.searchParams.delete("client_id"),
    (u: URL) => u.searchParams.set("client_id", "dynamic_agent_client"),
    (u: URL) => u.searchParams.set("error", "access_denied"),
    (u: URL) => u.searchParams.append("code", "second"),
    (u: URL) => {
      u.hostname = "localhost";
    },
  ]) {
    const changed = new URL(url);
    alter(changed);
    expect(() =>
      validateOpenAiCallback(changed, transaction, config),
    ).toThrow();
  }
  expect(() =>
    validateOpenAiCallback(url, transaction, config, transaction.expiresAt),
  ).toThrow();
  const returning = {
    ...transaction,
    clientId,
    expectedSubject: "synthetic-subject",
  };
  url.searchParams.delete("client_id");
  expect(validateOpenAiCallback(url, returning, config).clientId).toBe(
    clientId,
  );
  url.searchParams.set("client_id", "oaiapp_someoneelse");
  expect(() => validateOpenAiCallback(url, returning, config)).toThrow();
});
it("verifies ID token signatures, issuer, audience, time and nonce without trusting email alone", async () => {
  const nonce = "test-nonce";
  expect(
    await verifyOpenAiIdentity(jwt(nonce), clientId, metadata, nonce, keys),
  ).toMatchObject({
    subject: "synthetic-subject",
    email: "fixture@example.test",
  });
  for (const changes of [
    { iss: "https://attacker.test" },
    { aud: "other-client" },
    { exp: 1 },
    { iat: Math.floor(Date.now() / 1000) + 100 },
    { nonce: "wrong" },
    { nonce: undefined },
    { sub: "" },
    { aud: [clientId, "other"], azp: "other" },
  ])
    await expect(
      verifyOpenAiIdentity(
        jwt(nonce, changes),
        clientId,
        metadata,
        nonce,
        keys,
      ),
    ).rejects.toThrow();
  const valid = jwt(nonce),
    parts = valid.split(".");
  parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
  await expect(
    verifyOpenAiIdentity(parts.join("."), clientId, metadata, nonce, keys),
  ).rejects.toThrow();
  expect(
    (
      await verifyOpenAiIdentity(
        jwt(nonce, { email_verified: false }),
        clientId,
        metadata,
        nonce,
        keys,
      )
    ).email,
  ).toBeNull();
});
it("rejects hostile discovery endpoints rather than forwarding OAuth secrets", async () => {
  const document = {
    issuer: OPENAI_ISSUER,
    authorization_endpoint: metadata.authorizationEndpoint,
    token_endpoint: metadata.tokenEndpoint,
    jwks_uri: metadata.jwksUri,
    revocation_endpoint: metadata.revocationEndpoint,
    id_token_signing_alg_values_supported: ["RS256"],
  };
  expect(
    await discoverOpenAi(vi.fn().mockResolvedValue(Response.json(document))),
  ).toEqual(metadata);
  for (const overrides of [
    { issuer: "https://evil.test" },
    { token_endpoint: "https://evil.test/token" },
    { jwks_uri: "http://127.0.0.1/keys" },
    { id_token_signing_alg_values_supported: ["none"] },
  ])
    await expect(
      discoverOpenAi(
        vi.fn().mockResolvedValue(Response.json({ ...document, ...overrides })),
      ),
    ).rejects.toThrow();
});
it("exchanges using issued client ID, original verifier and resource, never a client secret", async () => {
  const transaction = createOpenAiTransaction(config, hostId);
  const fetcher = vi
    .fn()
    .mockResolvedValue(Response.json(body(jwt(transaction.nonce))));
  const result = await exchangeOpenAiCode(
    "fixture-code",
    clientId,
    transaction,
    metadata,
    fetcher,
    keys,
  );
  const request = fetcher.mock.calls[0][1] as RequestInit,
    params = request.body as URLSearchParams;
  expect(params.get("client_id")).toBe(clientId);
  expect(params.get("code_verifier")).toBe(transaction.verifier);
  expect(params.get("resource")).toBe(OPENAI_RESOURCE);
  expect(params.get("redirect_uri")).toBe(config.redirectUri);
  expect(new Headers(request.headers).has("authorization")).toBe(false);
  expect(hasOpenAiPlanScope(result.tokens.scopes)).toBe(true);
  await expect(
    exchangeOpenAiCode(
      "fixture",
      clientId,
      { ...transaction, expectedSubject: "another-user" },
      metadata,
      vi.fn().mockResolvedValue(Response.json(body(jwt(transaction.nonce)))),
      keys,
    ),
  ).rejects.toThrow();
});
it("identity-only consent never enables plan inference and incomplete plan credentials fail closed", () => {
  const identityOnly = parseOpenAiTokens(
    { id_token: "fixture", scope: "openid email profile" },
    "nonce",
  );
  expect(hasOpenAiPlanScope(identityOnly.scopes)).toBe(false);
  expect(identityOnly.accessToken).toBeNull();
  for (const overrides of [
    { refresh_token: null },
    { access_token: null },
    { token_type: "MAC" },
    { expires_in: -10 },
  ])
    expect(() =>
      parseOpenAiTokens(body("fixture", overrides), "nonce"),
    ).toThrow();
});
it("rotates refresh tokens without re-requesting scopes and accepts a refresh ID token without nonce", async () => {
  const previous = parseOpenAiTokens(body(jwt("nonce")), "nonce");
  const fetcher = vi.fn().mockResolvedValue(
    Response.json(
      body(jwt("nonce", { nonce: undefined }), {
        refresh_token: "rotated-refresh",
      }),
    ),
  );
  const next = await refreshOpenAiTokens(
    clientId,
    "synthetic-subject",
    previous,
    metadata,
    fetcher,
    keys,
  );
  expect(next.refreshToken).toBe("rotated-refresh");
  const params = fetcher.mock.calls[0][1].body as URLSearchParams;
  expect(params.get("grant_type")).toBe("refresh_token");
  expect(params.get("refresh_token")).toBe(previous.refreshToken);
  expect(params.has("scope")).toBe(false);
  await expect(
    refreshOpenAiTokens(
      clientId,
      "synthetic-subject",
      previous,
      metadata,
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: "invalid_grant" }, { status: 400 }),
        ),
      keys,
    ),
  ).rejects.toMatchObject({ code: "OPENAI_RECONNECT_REQUIRED" });
  await expect(
    refreshOpenAiTokens(
      clientId,
      "synthetic-subject",
      previous,
      metadata,
      vi.fn().mockResolvedValue(Response.json({}, { status: 503 })),
      keys,
    ),
  ).rejects.toMatchObject({ code: "OPENAI_REFRESH_UNAVAILABLE" });
});
