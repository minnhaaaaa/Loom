import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localDemoEnabled } from "../apps/web/server/demo-mode";

const database = vi.hoisted(() => ({
  isConfigured: vi.fn(() => false),
  readDatabase: vi.fn(),
  writeDatabase: vi.fn(),
}));

vi.mock("@loom/db-exasol", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@loom/db-exasol")>()),
  ...database,
}));

import { DatabaseUnavailable } from "@loom/db-exasol";
import { sampleSnapshot, snapshot } from "../apps/web/server/desk";

describe("local fixture authorization", () => {
  const local: NodeJS.ProcessEnv = {
    NODE_ENV: "development",
    LOOM_AUTH_MODE: "local-demo",
    APP_ORIGIN: "http://127.0.0.1:3100",
  };

  it.each([
    "http://127.0.0.1:3100",
    "http://localhost:3000",
    "https://localhost",
    "http://[::1]:3000",
  ])("allows explicitly configured local development at %s", (origin) => {
    expect(localDemoEnabled({ ...local, APP_ORIGIN: origin })).toBe(true);
  });

  it.each([
    ["default authentication", { LOOM_AUTH_MODE: undefined }],
    ["account authentication", { LOOM_AUTH_MODE: "workspace" }],
    ["missing origin", { APP_ORIGIN: undefined }],
    ["invalid origin", { APP_ORIGIN: "not a URL" }],
    ["public origin", { APP_ORIGIN: "https://loom.example" }],
    ["localhost suffix", { APP_ORIGIN: "http://localhost.example" }],
    ["private network", { APP_ORIGIN: "http://192.168.1.10:3000" }],
    ["unsupported protocol", { APP_ORIGIN: "ftp://localhost" }],
    ["production without opt-in", { NODE_ENV: "production" }],
    [
      "non-boolean production opt-in",
      { NODE_ENV: "production", LOOM_ALLOW_DEMO_PRODUCTION: "1" },
    ],
    [
      "production opt-in on a public origin",
      {
        NODE_ENV: "production",
        LOOM_ALLOW_DEMO_PRODUCTION: "true",
        APP_ORIGIN: "https://loom.example",
      },
    ],
  ] as const)("rejects %s", (_label, overrides) => {
    expect(localDemoEnabled({ ...local, ...overrides })).toBe(false);
  });

  it("allows the explicitly opted-in local production test server", () => {
    expect(
      localDemoEnabled({
        ...local,
        NODE_ENV: "production",
        LOOM_ALLOW_DEMO_PRODUCTION: "true",
      }),
    ).toBe(true);
  });
});

describe("unconfigured desks never silently become sample companies", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LOOM_AUTH_MODE", "workspace");
    vi.stubEnv("APP_ORIGIN", "https://loom.example");
    vi.stubEnv("LOOM_ALLOW_DEMO_PRODUCTION", "");
    for (const key of ["EXASOL_HOST", "EXASOL_USER", "EXASOL_PASSWORD"])
      vi.stubEnv(key, "");
    database.isConfigured.mockReset().mockReturnValue(false);
    database.readDatabase.mockReset();
    database.writeDatabase.mockReset();
  });

  afterEach(() => {
    expect(database.readDatabase).not.toHaveBeenCalled();
    expect(database.writeDatabase).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  function enableLocalFixtures() {
    vi.stubEnv("LOOM_AUTH_MODE", "local-demo");
    vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3100");
    vi.stubEnv("LOOM_ALLOW_DEMO_PRODUCTION", "true");
  }

  it("fails closed when Exasol is missing in the production account app", async () => {
    await expect(snapshot(null)).rejects.toBeInstanceOf(DatabaseUnavailable);
  });

  it("does not expose sampleSnapshot directly outside the local fixture mode", () => {
    expect(sampleSnapshot).toThrow(
      expect.objectContaining({ code: "DEMO_DISABLED", status: 404 }),
    );
  });

  it("permits read-only fixtures on the isolated local test server", async () => {
    enableLocalFixtures();
    const sample = sampleSnapshot();
    expect(sample.mode).toBe("preview");
    expect(sample.membership).toBeNull();
    expect(sample.requests.length).toBeGreaterThan(0);
    await expect(snapshot(null)).resolves.toEqual(sample);
  });

  it.each(["EXASOL_HOST", "EXASOL_USER", "EXASOL_PASSWORD"])(
    "fails closed for partial database configuration including %s, even in local fixture mode",
    async (key) => {
      enableLocalFixtures();
      vi.stubEnv(key, "configured-value");
      await expect(snapshot(null)).rejects.toBeInstanceOf(DatabaseUnavailable);
    },
  );

  it("does not replace an unauthenticated connected desk with fixture data", async () => {
    enableLocalFixtures();
    database.isConfigured.mockReturnValue(true);
    await expect(snapshot(null)).resolves.toEqual({
      mode: "connected",
      membership: null,
      requests: [],
      members: [],
    });
  });
});
