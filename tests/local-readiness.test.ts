import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { localConfigurationErrors } from "../scripts/lib/local-config.mjs";

const configuration = {
  APP_ORIGIN: "http://127.0.0.1:3000",
  LOOM_AUTH_MODE: "workspace",
  LOOM_ALLOW_WORKSPACE_SIGNUP: "false",
  LOOM_SESSION_SECRET:
    "b9d6f4c1813a0f2998bc03b1976e53e071816324cba1db38ffbc3c51a5e374b2",
  EXASOL_HOST: "database.internal",
  EXASOL_USER: "runtime",
  EXASOL_PASSWORD: "private-value-never-returned",
};
const boundary = vi.hoisted(() => ({ readDatabase: vi.fn(), query: vi.fn() }));
vi.mock("@loom/db-exasol", () => ({ readDatabase: boundary.readDatabase }));

beforeEach(() => {
  vi.resetModules();
  boundary.readDatabase.mockReset();
  boundary.query.mockReset();
  for (const [name, value] of Object.entries(configuration))
    vi.stubEnv(name, value);
  for (const name of [
    "LOOM_ALLOW_DEMO_PRODUCTION",
    "LOOM_ALLOW_SEED_FIXTURES",
    "LOOM_TEST_LIVE_MODEL",
    "LOOM_TEST_LIVE_TOOL_GENERATION",
    "LOOM_PROVIDER_ENCRYPTION_KEY",
    "LOOM_OPENAI_CLIENT_ID",
    "LOOM_OPENAI_REDIRECT_URI",
    "LOOM_OPENAI_LOCAL_ENABLED",
    "LOOM_OPENAI_HOST_ID",
    "OPENROUTER_API_KEY",
    "OPENROUTER_MODEL",
    "OPENROUTER_TOOL_MODEL",
    "EXASOL_CA_FILE",
    "PORT",
  ])
    vi.stubEnv(name, "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("permits local account mode without any global model or provider storage credential", () => {
  expect(localConfigurationErrors(configuration)).toEqual([]);
  expect(
    localConfigurationErrors({
      ...configuration,
      OPENROUTER_MODEL: "openrouter/free",
    }),
  ).toEqual([]);
});

const localOpenAiConfiguration = {
  ...configuration,
  LOOM_OPENAI_LOCAL_ENABLED: "true",
  LOOM_PROVIDER_ENCRYPTION_KEY: "3f".repeat(32),
};
it("requires encryption for enabled local ChatGPT and allows an automatically persisted host ID", () => {
  expect(localConfigurationErrors(localOpenAiConfiguration)).toEqual([]);
  expect(
    localConfigurationErrors({
      ...configuration,
      LOOM_OPENAI_LOCAL_ENABLED: "true",
    }),
  ).toContainEqual(expect.stringContaining("LOOM_PROVIDER_ENCRYPTION_KEY"));
  expect(
    localConfigurationErrors({
      ...configuration,
      LOOM_OPENAI_LOCAL_ENABLED: "false",
      APP_ORIGIN: "http://localhost:3000",
    }),
  ).toEqual([]);
});

it.each([
  "http://localhost:3000",
  "https://127.0.0.1:3000",
  "http://[::1]:3000",
  "http://127.0.0.1:3000/callback",
])(
  "requires the supported local ChatGPT callback origin instead of %s",
  (origin) => {
    expect(
      localConfigurationErrors({
        ...localOpenAiConfiguration,
        APP_ORIGIN: origin,
      }),
    ).toContainEqual(expect.stringContaining("APP_ORIGIN"));
  },
);

it("validates an explicit host identifier without returning its value", () => {
  expect(
    localConfigurationErrors({
      ...localOpenAiConfiguration,
      LOOM_OPENAI_HOST_ID: "urn:uuid:644f3a0a-1699-4b8f-88f7-73a78f639221",
    }),
  ).toEqual([]);
  const errors = localConfigurationErrors({
    ...localOpenAiConfiguration,
    LOOM_OPENAI_HOST_ID: "invalid-private-host-id",
  });
  expect(errors).toContainEqual(expect.stringContaining("LOOM_OPENAI_HOST_ID"));
  expect(errors.join(" ")).not.toContain("invalid-private-host-id");
  expect(
    localConfigurationErrors({
      ...configuration,
      LOOM_OPENAI_LOCAL_ENABLED: "yes",
    }),
  ).toContainEqual(expect.stringContaining("LOOM_OPENAI_LOCAL_ENABLED"));
});

it.each([
  "",
  "http://loom.company.com",
  "https://loom.company.com",
  "http://user:password@localhost:3000",
  "http://localhost:3000/app",
  "http://localhost:3000?mode=demo",
  "http://localhost:3000#app",
])("rejects a non-loopback or ambiguous local origin %s", (origin) => {
  expect(
    localConfigurationErrors({ ...configuration, APP_ORIGIN: origin }),
  ).toContainEqual(expect.stringContaining("APP_ORIGIN"));
});

it.each([
  "LOOM_ALLOW_DEMO_PRODUCTION",
  "LOOM_ALLOW_SEED_FIXTURES",
  "LOOM_TEST_LIVE_MODEL",
  "LOOM_TEST_LIVE_TOOL_GENERATION",
])("rejects an enabled test/fixture flag %s", (name) => {
  expect(
    localConfigurationErrors({ ...configuration, [name]: "true" }),
  ).toContain(`${name} must be false or unset.`);
});

it("rejects partial database, auth, and provider settings without returning their values", () => {
  const errors = localConfigurationErrors({
    ...configuration,
    EXASOL_USER: "",
    EXASOL_PORT: "invalid-private-port",
    EXASOL_SCHEMA: "invalid-private-schema",
    LOOM_AUTH_MODE: "local-demo",
    LOOM_PROVIDER_ENCRYPTION_KEY: "invalid-private-key",
    OPENROUTER_API_KEY: "private-api-key",
  });
  expect(errors.length).toBeGreaterThanOrEqual(6);
  expect(errors.join(" ")).not.toMatch(
    /private-port|private-schema|private-key|private-api-key/,
  );
});

it.each([
  "short",
  "public-test-only-session-key-do-not-deploy",
  "x".repeat(64),
])("rejects placeholder session secrets", (secret) => {
  expect(
    localConfigurationErrors({ ...configuration, LOOM_SESSION_SECRET: secret }),
  ).toContainEqual(expect.stringContaining("LOOM_SESSION_SECRET"));
});

async function migrationRows() {
  const directory = new URL("../exasol/migrations/", import.meta.url);
  return Promise.all(
    (await readdir(directory))
      .filter((file) => /^\d{3}_[a-z_]+\.sql$/.test(file))
      .map(async (file) => ({
        VERSION: file.slice(0, -4),
        CONTENT_HASH: createHash("sha256")
          .update(await readFile(new URL(file, directory)))
          .digest("hex"),
      })),
  );
}
async function configureDatabase(changed = false) {
  const rows = await migrationRows();
  if (changed) rows[0].CONTENT_HASH = "mismatched";
  boundary.query.mockImplementation(async (query: string) =>
    query === "SELECT 1 AS READY" ? [{ READY: 1 }] : rows,
  );
  boundary.readDatabase.mockImplementation(
    async (work: (sql: { query: typeof boundary.query }) => unknown) =>
      work({ query: boundary.query }),
  );
}

it("liveness does not depend on the database or expose deployment details", async () => {
  const { GET } = await import("../apps/web/app/api/health/live/route");
  const response = GET();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
  expect(boundary.readDatabase).not.toHaveBeenCalled();
});

it("readiness fails closed on bad configuration without opening a database connection", async () => {
  vi.stubEnv("APP_ORIGIN", "");
  const { GET } = await import("../apps/web/app/api/health/ready/route");
  const response = await GET();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ status: "unavailable" });
  expect(boundary.readDatabase).not.toHaveBeenCalled();
});

it("readiness performs only the ping and exact migration reads, cached for 30 seconds", async () => {
  await configureDatabase();
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const { GET } = await import("../apps/web/app/api/health/ready/route");
  expect((await GET()).status).toBe(200);
  expect((await GET()).status).toBe(200);
  expect(boundary.readDatabase).toHaveBeenCalledTimes(1);
  expect(boundary.query.mock.calls.map(([query]) => query)).toEqual([
    "SELECT 1 AS READY",
    "SELECT VERSION,CONTENT_HASH FROM SCHEMA_MIGRATIONS ORDER BY VERSION",
  ]);
  now += 30_001;
  expect((await GET()).status).toBe(200);
  expect(boundary.readDatabase).toHaveBeenCalledTimes(2);
});

it("readiness rejects changed, missing, duplicate, or future migration records", async () => {
  await configureDatabase(true);
  const { GET } = await import("../apps/web/app/api/health/ready/route");
  expect((await GET()).status).toBe(503);
  const { migrationStateMatches } =
    await import("../apps/web/server/deployment-config");
  const rows = [{ VERSION: "001_example", CONTENT_HASH: "exact" }];
  expect(migrationStateMatches(rows, [])).toBe(false);
  expect(migrationStateMatches(rows, [...rows, ...rows])).toBe(false);
  expect(
    migrationStateMatches(rows, [
      ...rows,
      { VERSION: "999_future", CONTENT_HASH: "future" },
    ]),
  ).toBe(false);
});

it("readiness returns a generic failure without leaking a driver error", async () => {
  boundary.readDatabase.mockRejectedValue(
    new Error("private database host/user/password"),
  );
  const { GET } = await import("../apps/web/app/api/health/ready/route");
  const response = await GET();
  expect(response.status).toBe(503);
  expect(await response.text()).toBe('{"status":"unavailable"}');
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it("concurrent probes keep a single database operation in flight", async () => {
  let release!: (ready: boolean) => void;
  boundary.readDatabase.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
  );
  const { deploymentReady } =
    await import("../apps/web/server/deployment-config");
  const first = deploymentReady();
  const second = deploymentReady();
  await vi.waitFor(() =>
    expect(boundary.readDatabase).toHaveBeenCalledTimes(1),
  );
  release(true);
  await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
});

it("readiness times out without starting overlapping database probes", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let release!: (ready: boolean) => void;
  boundary.readDatabase.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
  );
  const { deploymentReady } =
    await import("../apps/web/server/deployment-config");
  const first = deploymentReady();
  await vi.waitFor(() =>
    expect(boundary.readDatabase).toHaveBeenCalledTimes(1),
  );
  await vi.advanceTimersByTimeAsync(5_000);
  await expect(first).resolves.toBe(false);
  const second = deploymentReady();
  await vi.advanceTimersByTimeAsync(5_000);
  await expect(second).resolves.toBe(false);
  expect(boundary.readDatabase).toHaveBeenCalledTimes(1);
  release(true);
  await expect(deploymentReady()).resolves.toBe(true);
});
