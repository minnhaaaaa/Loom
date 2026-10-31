import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dataRequestTemplate } from "@loom/contracts";
import { DomainError } from "@loom/domain";
import { generateToolDraft } from "../apps/web/server/tools";

// Only the orchestration boundary is scripted here; no database or provider calls.
const boundary = vi.hoisted(() => ({
  query: vi.fn(),
  execute: vi.fn(),
  infer: vi.fn(),
  generation: null as Record<string, unknown> | null,
}));
vi.mock("@loom/db-exasol", () => ({
  fromTimestamp: (value: unknown) => String(value),
  sqlTimestamp: (value: string) => value,
  readDatabase: (work: (sql: unknown) => unknown) => work(boundary),
  writeDatabase: (work: (sql: unknown) => unknown) => work(boundary),
}));
vi.mock("../apps/web/server/desk", async () => {
  const { createHash } = await import("node:crypto");
  return {
    digest: (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    membership: async () => ({
      userId: "owner",
      name: "Fixture owner",
      role: "owner",
    }),
    receipt: async () => null,
  };
});
vi.mock("../apps/web/server/tool-definitions", () => ({
  publishedTool: async () => ({
    revision: 1,
    spec: dataRequestTemplate,
    publishedAt: null,
  }),
  mapPublishedTool: vi.fn(),
}));
vi.mock("../apps/web/server/tool-generation", () => ({
  generateDefinition: boundary.infer,
  toolGenerationPromptVersion: "fixture-prompt",
  toolModelConfiguration: () => ({
    model: "fixture/model:free",
    freeOnly: true,
  }),
}));

const actor = { workspaceId: "workspace", userId: "owner" };
const start = () =>
  generateToolDraft(
    actor,
    "same-command",
    1,
    "Refine the title",
    dataRequestTemplate,
  );
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
  boundary.generation = null;
  boundary.infer.mockReset();
  boundary.query.mockReset().mockImplementation(async (sql: string) => {
    if (sql.includes("FROM TOOL_GENERATIONS"))
      return boundary.generation ? [{ ...boundary.generation }] : [];
    throw new Error("Unexpected scripted SQL query");
  });
  boundary.execute
    .mockReset()
    .mockImplementation(async (sql: string, values: unknown[]) => {
      if (sql.startsWith("INSERT INTO TOOL_GENERATIONS")) {
        boundary.generation = {
          COMMAND_ID: values[1],
          ACTOR_ID: values[2],
          PAYLOAD_HASH: values[3],
          BASE_REVISION: values[4],
          LIFECYCLE: "running",
          ATTEMPTS: 1,
          LEASE_ID: values[5],
          LEASE_UNTIL: values[6],
          INFERENCE_JSON: values[7],
        };
      } else if (
        sql.startsWith("UPDATE TOOL_GENERATIONS SET LIFECYCLE='running'")
      ) {
        Object.assign(boundary.generation!, {
          LIFECYCLE: "running",
          ATTEMPTS: Number(boundary.generation!.ATTEMPTS) + 1,
          LEASE_ID: values[0],
          LEASE_UNTIL: values[1],
        });
      } else if (
        sql.startsWith("UPDATE TOOL_GENERATIONS SET LIFECYCLE='failed'")
      ) {
        const generation = boundary.generation;
        if (
          generation &&
          generation.LEASE_ID === values[5] &&
          generation.LIFECYCLE === "running"
        )
          Object.assign(generation, {
            LIFECYCLE: "failed",
            ERROR_CODE: values[0],
            LEASE_UNTIL: values[1],
          });
      } else throw new Error("Unexpected scripted SQL mutation");
      return 1;
    });
});
afterEach(() => {
  vi.useRealTimers();
});

it("persists provider cooldown without consuming another attempt, then permits one explicit retry after expiry", async () => {
  boundary.infer.mockRejectedValueOnce(
    new DomainError("MODEL_HTTP_429", "Provider limit.", 429, {
      retryAfterSeconds: 30,
      retryable: true,
    }),
  );
  await expect(start()).rejects.toMatchObject({
    code: "MODEL_HTTP_429",
    details: { retryAfterSeconds: 30 },
  });
  expect(boundary.generation).toMatchObject({
    LIFECYCLE: "failed",
    ATTEMPTS: 1,
    LEASE_UNTIL: "2026-10-27T12:00:30.000Z",
  });
  vi.setSystemTime(new Date("2026-10-27T12:00:10Z"));
  await expect(start()).rejects.toMatchObject({
    code: "MODEL_HTTP_429",
    status: 429,
    details: { retryAfterSeconds: 20, retryable: true },
  });
  expect(boundary.infer).toHaveBeenCalledTimes(1);
  expect(boundary.generation!.ATTEMPTS).toBe(1);
  vi.setSystemTime(new Date("2026-10-27T12:00:30Z"));
  boundary.infer.mockRejectedValueOnce(
    new DomainError("MODEL_NETWORK", "Explicit retry failed.", 502, {
      retryable: true,
    }),
  );
  await expect(start()).rejects.toMatchObject({ code: "MODEL_NETWORK" });
  expect(boundary.infer).toHaveBeenCalledTimes(2);
  expect(boundary.generation).toMatchObject({
    LIFECYCLE: "failed",
    ATTEMPTS: 2,
    LEASE_UNTIL: "2026-10-27T12:00:30.000Z",
  });
  await expect(start()).rejects.toMatchObject({
    code: "GENERATION_RETRY_LIMIT",
  });
  expect(boundary.infer).toHaveBeenCalledTimes(2);
});

it("clears the running lease on a failure without a provider cooldown", async () => {
  boundary.infer.mockRejectedValue(
    new DomainError("MODEL_OUTPUT_INVALID", "Malformed output.", 502, {
      retryable: true,
    }),
  );
  await expect(start()).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
  expect(boundary.generation).toMatchObject({
    LIFECYCLE: "failed",
    ATTEMPTS: 1,
    LEASE_UNTIL: "2026-10-27T12:00:00.000Z",
  });
  await expect(start()).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
  expect(boundary.generation!.ATTEMPTS).toBe(2);
  expect(boundary.infer).toHaveBeenCalledTimes(2);
});
