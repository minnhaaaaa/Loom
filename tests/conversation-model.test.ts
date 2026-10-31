import { afterEach, expect, it, vi } from "vitest";
import { modelActionParameters } from "@loom/contracts";
import {
  inferConversation,
  parseConversationOutput,
} from "../apps/web/server/conversation-model";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function configure() {
  vi.stubEnv("OPENROUTER_API_KEY", "public-fixture-only");
  vi.stubEnv("OPENROUTER_MODEL", "fixture/conversation:free");
  vi.stubEnv("OPENROUTER_FREE_ONLY", "true");
}
const answer = {
  reply: "A review brief explains the decision your team needs to make.",
  evidenceIds: [],
  toolInstructions: null,
  proposals: [],
};
function envelope(content: string, finishReason = "stop") {
  return Response.json({
    id: "fixture-generation",
    model: "fixture/actual:free",
    choices: [{ finish_reason: finishReason, message: { content } }],
    usage: { prompt_tokens: 20, completion_tokens: 40, cost: 0 },
  });
}
it("answers an arbitrary prompt with no selected records and no forced change", async () => {
  configure();
  const fetch = vi.fn().mockResolvedValue(envelope(JSON.stringify(answer)));
  vi.stubGlobal("fetch", fetch);
  const context = {
    prompt: "What makes a useful review brief?",
    records: [],
    knowledge: [],
    allowProposals: false,
  };
  const reply = await inferConversation(context, "fixture/conversation:free");
  expect(reply.decision).toEqual(answer);
  const request = JSON.parse(fetch.mock.calls[0][1].body);
  expect(JSON.parse(request.messages[1].content).context).toEqual(context);
  expect(request.provider).toMatchObject({
    data_collection: "deny",
    max_price: { prompt: 0, completion: 0, request: 0 },
  });
  expect(request.response_format.json_schema.strict).toBe(true);
});
it("decodes model-chosen tool design and direct command choices without keyword routing", () => {
  const parameters = Object.fromEntries(
    Object.keys(modelActionParameters).map((key) => [key, null]),
  );
  expect(
    parseConversationOutput(
      JSON.stringify({
        ...answer,
        toolInstructions: "Create a project review tracker.",
        proposals: [
          {
            requestId: "10000000-0000-4000-8000-000000000001",
            expectedVersion: 1,
            reasons: ["The user asked for this change."],
            uncertainty: [],
            evidenceIds: [],
            commands: [
              {
                type: "set_priority",
                parameters: { ...parameters, priority: "high" },
              },
            ],
          },
        ],
      }),
    ),
  ).toMatchObject({
    toolInstructions: "Create a project review tracker.",
    proposals: [{ commands: [{ type: "set_priority", priority: "high" }] }],
  });
  expect(() =>
    parseConversationOutput(
      JSON.stringify({
        ...answer,
        proposals: [
          {
            requestId: "10000000-0000-4000-8000-000000000001",
            expectedVersion: 1,
            reasons: ["x"],
            uncertainty: [],
            evidenceIds: [],
            commands: [
              {
                type: "set_priority",
                parameters: {
                  ...parameters,
                  priority: "high",
                  body: "Unrelated command argument",
                },
              },
            ],
          },
        ],
      }),
    ),
  ).toThrow();
});
it("surfaces provider failures and never substitutes a canned reply", async () => {
  configure();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ error: { code: 429 } })),
  );
  await expect(
    inferConversation({}, "fixture/conversation:free"),
  ).rejects.toMatchObject({ code: "MODEL_HTTP_429" });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(envelope("", "length")));
  await expect(
    inferConversation({}, "fixture/conversation:free"),
  ).rejects.toMatchObject({ code: "MODEL_TOKEN_LIMIT" });
});
