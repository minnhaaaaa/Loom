import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dataRequestTemplate, type ToolSpec } from "@loom/contracts";
import { DomainError } from "@loom/domain";
import { generateToolDraft } from "../apps/web/server/tools";

// This suite isolates orchestration races. SQL constraints/transactions are
// exercised separately by the real Exasol integration suites.
const boundary = vi.hoisted(() => ({
  query: vi.fn(),
  execute: vi.fn(),
  infer: vi.fn(),
  ownerActive: true,
  generation: null as Record<string, unknown> | null,
  drafts: new Map<string, Record<string, unknown>>(),
  receipts: new Map<string, { hash: string; result: unknown }>(),
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
    membership: async () => {
      if (!boundary.ownerActive)
        throw new DomainError(
          "ACCESS_DENIED",
          "Workspace access revoked.",
          403,
        );
      return { userId: "owner", name: "Fixture owner", role: "owner" };
    },
    receipt: async (
      _sql: unknown,
      _actor: unknown,
      id: string,
      hash: string,
    ) => {
      const receipt = boundary.receipts.get(id);
      if (receipt && receipt.hash !== hash)
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          "Different payload.",
          409,
        );
      return receipt?.result ?? null;
    },
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
vi.mock("../apps/web/server/openrouter", () => ({
  modelConfiguration: () => ({
    key: "public-test-only",
    model: "fixture/model:free",
    freeOnly: true,
  }),
}));
vi.mock("../apps/web/server/tool-generation", () => ({
  generateDefinition: boundary.infer,
  toolGenerationPromptVersion: "fixture-prompt-v1",
  toolModelConfiguration: () => ({
    key: "public-test-only",
    model: "fixture/model:free",
    freeOnly: true,
  }),
}));

const actor = { workspaceId: "workspace", userId: "owner" };
const start = (id = "command") =>
  generateToolDraft(actor, id, 1, "Refine the title", dataRequestTemplate);
function output(title: string) {
  return {
    spec: { ...structuredClone(dataRequestTemplate), title } satisfies ToolSpec,
    assumptions: [],
    unsupported: [],
    inference: {
      requestedModel: "fixture/model:free",
      actualModel: "fixture/model:free",
      generationId: title,
      promptVersion: "fixture-prompt-v1",
      promptTokens: 10,
      completionTokens: 20,
      cost: 0,
      durationMs: 1,
    },
  };
}
function deferredInference() {
  let resolve!: (value: ReturnType<typeof output>) => void;
  let entered!: () => void;
  const started = new Promise<void>((done) => {
    entered = done;
  });
  boundary.infer.mockImplementationOnce(() => {
    entered();
    return new Promise<ReturnType<typeof output>>((done) => {
      resolve = done;
    });
  });
  return { started, finish: (title: string) => resolve(output(title)) };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
  boundary.ownerActive = true;
  boundary.generation = null;
  boundary.drafts.clear();
  boundary.receipts.clear();
  boundary.infer.mockReset();
  boundary.query
    .mockReset()
    .mockImplementation(async (sql: string, values: unknown[]) => {
      if (sql.includes("FROM TOOL_GENERATIONS")) {
        const generation = boundary.generation;
        if (!generation) return [];
        if (sql.includes("DRAFT_ID =") && generation.DRAFT_ID !== values[1])
          return [];
        if (!sql.includes("DRAFT_ID =") && generation.COMMAND_ID !== values[1])
          return [];
        return [{ ...generation }];
      }
      if (sql.includes("FROM TOOL_DRAFTS")) {
        const draft = boundary.drafts.get(String(values[1]));
        return draft
          ? [
              {
                ...draft,
                GENERATION_INFERENCE_JSON: boundary.generation?.INFERENCE_JSON,
              },
            ]
          : [];
      }
      throw new Error(`Unexpected test query: ${sql}`);
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
        const generation = boundary.generation;
        if (!generation) return 0;
        Object.assign(generation, {
          LIFECYCLE: "running",
          ATTEMPTS: Number(generation.ATTEMPTS) + 1,
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
      } else if (
        sql.startsWith("UPDATE TOOL_GENERATIONS SET LIFECYCLE='complete'")
      ) {
        const generation = boundary.generation;
        if (!generation || generation.LEASE_ID !== values[4]) return 0;
        Object.assign(generation, {
          LIFECYCLE: "complete",
          DRAFT_ID: values[0],
          INFERENCE_JSON: values[1],
        });
      } else if (sql.startsWith("INSERT INTO TOOL_DRAFTS")) {
        boundary.drafts.set(String(values[1]), {
          ID: values[1],
          BASE_REVISION: values[2],
          SPEC_JSON: values[3],
          INSTRUCTIONS: values[4],
          ASSUMPTIONS_JSON: values[5],
          UNSUPPORTED_JSON: values[6],
          CONTENT_HASH: values[7],
          CREATED_AT: values[9],
        });
      } else if (sql.startsWith("INSERT INTO COMMAND_RECEIPTS")) {
        boundary.receipts.set(String(values[1]), {
          hash: String(values[3]),
          result: JSON.parse(String(values[4])),
        });
      } else if (!sql.startsWith("INSERT INTO TOOL_EVENTS")) {
        throw new Error(`Unexpected test mutation: ${sql}`);
      }
      return 1;
    });
});
afterEach(() => {
  vi.useRealTimers();
});

it("rejects late output after lease takeover without poisoning the replacement or repeating its saved inference", async () => {
  const first = deferredInference();
  const abandoned = start();
  await first.started;
  vi.setSystemTime(new Date("2026-10-27T12:02:01Z"));
  const second = deferredInference();
  const replacement = start();
  await second.started;
  first.finish("Expired result");
  await expect(abandoned).rejects.toMatchObject({ code: "GENERATION_EXPIRED" });
  expect(boundary.drafts.size).toBe(0);
  expect(boundary.receipts.size).toBe(0);
  expect(boundary.generation?.LIFECYCLE).toBe("running");
  second.finish("Current result");
  const draft = await replacement;
  expect(draft.spec.title).toBe("Current result");
  expect(draft.inference).toEqual(output("Current result").inference);
  expect(boundary.drafts.size).toBe(1);
  expect(boundary.receipts.size).toBe(1);
  const replayed = await start();
  expect(replayed.id).toBe(draft.id);
  expect(replayed.inference).toEqual(draft.inference);
  expect(boundary.infer).toHaveBeenCalledTimes(2);
});

it("discards a provider result after owner revocation without creating a draft or receipt", async () => {
  const provider = deferredInference();
  const pending = start();
  await provider.started;
  boundary.ownerActive = false;
  provider.finish("Output after revocation");
  await expect(pending).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  expect(boundary.drafts.size).toBe(0);
  expect(boundary.receipts.size).toBe(0);
  expect(boundary.generation?.LIFECYCLE).toBe("failed");
});

it("bounds repeated failed calls for one command and permits a deliberately new generation", async () => {
  boundary.infer.mockRejectedValue(
    new DomainError("MODEL_NETWORK", "Fixture outage.", 502),
  );
  await expect(start()).rejects.toMatchObject({ code: "MODEL_NETWORK" });
  await expect(start()).rejects.toMatchObject({ code: "MODEL_NETWORK" });
  await expect(start()).rejects.toMatchObject({
    code: "GENERATION_RETRY_LIMIT",
  });
  expect(boundary.infer).toHaveBeenCalledTimes(2);
  boundary.infer.mockResolvedValue(output("New generation"));
  const draft = await start("explicit-new-command");
  expect(draft.spec.title).toBe("New generation");
  expect(boundary.infer).toHaveBeenCalledTimes(3);
});
