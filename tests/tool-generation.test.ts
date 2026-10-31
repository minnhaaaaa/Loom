import { afterEach, expect, it, vi } from "vitest";
import { dataRequestTemplate, type ToolSpec } from "@loom/contracts";
import { generateDefinition } from "../apps/web/server/tool-generation";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
function configure() {
  vi.stubEnv("OPENROUTER_API_KEY", "public-test-fixture");
  vi.stubEnv("OPENROUTER_MODEL", "fixture/model:free");
  vi.stubEnv("OPENROUTER_FREE_ONLY", "true");
}
function envelope(output: unknown, finish_reason = "stop") {
  return {
    id: "fixture-generation",
    model: "fixture/model:free",
    choices: [{ finish_reason, message: { content: JSON.stringify(output) } }],
    usage: { prompt_tokens: 40, completion_tokens: 90, cost: 0 },
  };
}
function toWire(
  spec: ToolSpec,
  assumptions: string[] = [],
  unsupported: string[] = [],
) {
  const queue = spec.views.find((view) => view.id === "queue")!,
    filters = spec.views.find((view) => view.id === "filters")!,
    summary = spec.views.find((view) => view.id === "summary")!;
  return {
    definition: {
      title: spec.title,
      description: spec.description,
      coreLabels: {
        title: spec.fields.find((field) => field.id === "title")!.label,
        businessQuestion: spec.fields.find(
          (field) => field.id === "businessQuestion",
        )!.label,
        reportingPeriod: spec.fields.find(
          (field) => field.id === "reportingPeriod",
        )!.label,
        dataset: spec.fields.find((field) => field.id === "dataset")!.label,
      },
      customFields: spec.fields.filter((field) =>
        field.id.startsWith("custom_"),
      ),
      queueColumns: queue.columns,
      searchEnabled: filters.search,
      statusFilterEnabled: filters.status,
      summaryMetrics: summary.metrics,
      actions: spec.actions,
      statusLabels: spec.statusLabels,
    },
    assumptions,
    unsupported,
  };
}
it("requires configuration and never substitutes a generated template", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(
    generateDefinition("An IT desk", dataRequestTemplate),
  ).rejects.toMatchObject({ code: "MODEL_NOT_CONFIGURED" });
  expect(fetch).not.toHaveBeenCalled();
});
it("generates a validated draft with explicit assumptions using private zero-price routing", async () => {
  configure();
  const output = {
    spec: { ...dataRequestTemplate, title: "IT requests" },
    assumptions: ["Existing fields retain their storage keys."],
    unsupported: ["Ticket-system synchronization requires an integration."],
  };
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json(
        envelope(toWire(output.spec, output.assumptions, output.unsupported)),
      ),
    );
  vi.stubGlobal("fetch", fetch);
  const result = await generateDefinition(
    "An IT desk with ticket synchronization",
    dataRequestTemplate,
  );
  expect(result).toMatchObject(output);
  expect(result.inference.cost).toBe(0);
  const body = JSON.parse(fetch.mock.calls[0][1].body);
  expect(body.provider).toEqual({
    require_parameters: true,
    data_collection: "deny",
    max_price: { prompt: 0, completion: 0, request: 0 },
  });
  expect(body.response_format.json_schema.strict).toBe(true);
  const schema = body.response_format.json_schema.schema;
  expect(JSON.stringify(schema)).not.toMatch(/"(?:anyOf|oneOf)"/);
  expect(
    schema.properties.definition.properties.customFields.items.properties
      .requiredAt.enum,
  ).toEqual(["optional", "ready"]);
  expect(JSON.parse(body.messages[1].content).instructions).toBe(
    "An IT desk with ticket synchronization",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("rejects unsupported executable output, invalid references, and truncated output without repair", async () => {
  configure();
  const valid = toWire(dataRequestTemplate);
  for (const output of [
    {
      ...valid,
      definition: { ...valid.definition, sql: "DROP TABLE REQUESTS" },
    },
    {
      ...valid,
      definition: { ...valid.definition, actions: ["run.arbitrary_code"] },
    },
  ]) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json(envelope(output))),
    );
    await expect(
      generateDefinition("Describe a tool", dataRequestTemplate),
    ).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
  }
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json(envelope({}, "length"))),
  );
  await expect(
    generateDefinition("Describe a tool", dataRequestTemplate),
  ).rejects.toMatchObject({ code: "MODEL_TOKEN_LIMIT" });
});
it("does not disclose provider diagnostics or automatically retry a failed call", async () => {
  configure();
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json(
        { error: { message: "private fixture diagnostic" } },
        { status: 429 },
      ),
    );
  vi.stubGlobal("fetch", fetch);
  await expect(
    generateDefinition("An IT desk", dataRequestTemplate),
  ).rejects.toMatchObject({ code: "MODEL_HTTP_429" });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("explains validation failures by safe schema path without echoing model-authored values", async () => {
  configure();
  const spec = structuredClone(dataRequestTemplate);
  const queue = spec.views.find((view) => view.id === "queue")!;
  queue.columns = ["title", "private_model_output_do_not_echo"];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json(envelope(toWire(spec)))),
  );
  let message = "";
  try {
    await generateDefinition("Describe a tool", dataRequestTemplate);
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain("spec.views.0.columns.1");
  expect(message).toContain("Use unique existing field or system column IDs");
  expect(message).not.toContain("private_model_output_do_not_echo");
});
it("assembles exact model choices into the fixed catalog and validates the complete specification", async () => {
  configure();
  const spec: ToolSpec = {
    ...structuredClone(dataRequestTemplate),
    title: "Facilities desk",
  };
  spec.fields[0].label = "Issue";
  spec.fields.push({
    id: "custom_office",
    label: "Office",
    type: "text",
    requiredAt: "optional",
    maxLength: 90,
    visible: true,
  });
  const wire = toWire(spec);
  wire.definition.queueColumns.push("custom_office");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json(envelope(wire))),
  );
  const result = await generateDefinition(
    "An optional Office field",
    dataRequestTemplate,
  );
  expect(result.spec).toEqual(spec);
  expect(result.spec.fields[0]).toMatchObject({
    id: "title",
    type: "text",
    maxLength: 160,
    requiredAt: "intake",
    visible: true,
    label: "Issue",
  });
  expect(result.spec.views).toHaveLength(5);
  const bad = toWire(spec);
  bad.definition.customFields[0].requiredAt = "ready";
  bad.definition.customFields[0].visible = false;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json(envelope(bad))),
  );
  await expect(
    generateDefinition("Office required at readiness", dataRequestTemplate),
  ).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
});

it("preserves an existing field order and core metadata during a title-only refinement", async () => {
  configure();
  const base = structuredClone(dataRequestTemplate);
  base.fields.splice(1, 0, {
    id: "custom_office",
    label: "Office",
    type: "text",
    requiredAt: "optional",
    maxLength: 100,
    visible: true,
  });
  [base.fields[0], base.fields[2]] = [base.fields[2], base.fields[0]];
  const output = { ...base, title: "Refined desk" };
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json(envelope(toWire(output)))),
  );
  expect(
    (await generateDefinition("Change only the title", base)).spec,
  ).toEqual(output);
});

it("supports a separate designer model while preserving free-only routing", async () => {
  configure();
  vi.stubEnv("OPENROUTER_TOOL_MODEL", "fixture/designer:free");
  const fetch = vi
    .fn()
    .mockResolvedValue(Response.json(envelope(toWire(dataRequestTemplate))));
  vi.stubGlobal("fetch", fetch);
  const result = await generateDefinition(
    "Keep this tool",
    dataRequestTemplate,
    "fixture/designer:free",
  );
  expect(JSON.parse(fetch.mock.calls[0][1].body).model).toBe(
    "fixture/designer:free",
  );
  expect(result.inference.requestedModel).toBe("fixture/designer:free");
  vi.stubEnv("OPENROUTER_TOOL_MODEL", "fixture/paid-designer");
  await expect(
    generateDefinition("Keep this tool", dataRequestTemplate),
  ).rejects.toMatchObject({ code: "MODEL_COST_POLICY" });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("recognizes provider failures inside HTTP 200 and carries the explicit retry delay", async () => {
  configure();
  const fetch = vi.fn().mockResolvedValue(
    Response.json(
      {
        choices: [{ error: { code: 429, message: "secret upstream body" } }],
      },
      { headers: { "Retry-After": "45" } },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  await expect(
    generateDefinition("Keep this tool", dataRequestTemplate),
  ).rejects.toMatchObject({
    code: "MODEL_HTTP_429",
    status: 429,
    details: { retryAfterSeconds: 45, retryable: true },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("honors rate limits even when the upstream error body is unreadable", async () => {
  configure();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response("not JSON", {
        status: 429,
        headers: { "Retry-After": "120" },
      }),
    ),
  );
  await expect(
    generateDefinition("Keep this tool", dataRequestTemplate),
  ).rejects.toMatchObject({
    code: "MODEL_HTTP_429",
    details: { retryAfterSeconds: 120 },
  });
});
