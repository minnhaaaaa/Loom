import { afterEach, describe, expect, it, vi } from "vitest";
import { dataRequestTemplate } from "@loom/contracts";
import { inferConversation } from "../apps/web/server/conversation-model";
import { generateDefinition } from "../apps/web/server/tool-generation";
import {
  providerFetch,
  type ProviderRuntimeConfig,
} from "../apps/web/server/provider-transport";

const config: ProviderRuntimeConfig = {
  provider: "openai-chatgpt",
  key: "synthetic-oauth-access-token",
  model: "selected-account-model",
  maxTokens: 4096,
  timeoutMs: 1000,
  freeOnly: false,
};
const request = {
  system: "Return the requested JSON.",
  input: "Synthetic input only.",
  schemaName: "loom_test",
  schema: {
    type: "object",
    properties: { reply: { type: "string" } },
    required: ["reply"],
    additionalProperties: false,
  },
};
const encoder = new TextEncoder();
const reply = '{"reply":"Café 🧵"}';
function completed(content = reply) {
  return {
    type: "response.completed",
    response: {
      id: "resp_fixture",
      model: "actual-account-model",
      status: "completed",
      error: null,
      incomplete_details: null,
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: content }],
        },
      ],
      usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
    },
  };
}
function event(value: unknown, newline = "\n") {
  return `data: ${JSON.stringify(value)}${newline}${newline}`;
}
function fixture(chunks: (string | Uint8Array)[], holdOpen = false) {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks)
        controller.enqueue(
          typeof chunk === "string" ? encoder.encode(chunk) : chunk,
        );
      if (!holdOpen) controller.close();
    },
    cancel,
  });
  const response = new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "x-request-id": "req_fixture",
    },
  });
  const fetch = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetch);
  return { fetch, cancel, response };
}

afterEach(() => vi.unstubAllGlobals());

describe("ChatGPT plan Responses transport (synthetic streams only)", () => {
  it("uses finalized items when the terminal event omits their contents", async () => {
    const done = completed();
    fixture([
      event({
        type: "response.output_item.done",
        output_index: 0,
        item: done.response.output[0],
      }),
      event({ ...done, response: { ...done.response, output: [] } }),
    ]);
    const result = await providerFetch(config, request);
    expect((await result.json()).choices[0].message.content).toBe(reply);
  });

  it("rejects finalized items without response.completed", async () => {
    fixture([
      event({
        type: "response.output_item.done",
        output_index: 0,
        item: completed().response.output[0],
      }),
    ]);
    await expect(providerFetch(config, request)).rejects.toThrow();
  });

  it("validates completed SSE even when the provider omits Content-Type", async () => {
    const { response } = fixture([event(completed())]);
    response.headers.delete("content-type");
    const result = await providerFetch(config, request);
    expect((await result.json()).choices[0].message.content).toBe(reply);
  });

  it("rejects a headerless body without a completed event", async () => {
    const { response } = fixture(['{"reply":"not an event"}']);
    response.headers.delete("content-type");
    await expect(providerFetch(config, request)).rejects.toThrow();
  });

  it("preserves reconnect classification through conversation and tool generation", async () => {
    const fetch = vi
      .fn()
      .mockImplementation(async () =>
        Response.json(
          { detail: "Private admission diagnostic" },
          { status: 401 },
        ),
      );
    vi.stubGlobal("fetch", fetch);
    for (const run of [
      () => inferConversation({}, config.model, undefined, config),
      () =>
        generateDefinition(
          "A request desk",
          dataRequestTemplate,
          config.model,
          config,
        ),
    ]) {
      await expect(run()).rejects.toMatchObject({
        code: "OPENAI_RECONNECT_REQUIRED",
        details: { retryable: false },
      });
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("describes interrupted personal-plan generation without API billing language", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Offline")));
    await expect(
      generateDefinition(
        "A request desk",
        dataRequestTemplate,
        config.model,
        config,
      ),
    ).rejects.toMatchObject({
      code: "MODEL_NETWORK",
      message: expect.stringContaining("ChatGPT plan allowance"),
    });
  });

  it("uses only the public OAuth Responses route and the selected account model", async () => {
    const { fetch } = fixture([event(completed())]);
    const result = await providerFetch(config, {
      ...request,
      model: "not-the-selected-model",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(options).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${config.key}`,
        Accept: "text/event-stream",
        "Content-Type": "application/json",
      },
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(options.body);
    expect(body).toEqual({
      model: config.model,
      store: false,
      stream: true,
      instructions: request.system,
      input: [
        {
          role: "developer",
          content: `Return only a JSON object matching this schema:\n${JSON.stringify(request.schema)}`,
        },
        { role: "user", content: request.input },
      ],
      text: {
        format: { type: "json_object" },
      },
    });
    expect(options.body).not.toContain(config.key);
    expect(result.headers.get("x-request-id")).toBe("req_fixture");
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toEqual({
      id: "resp_fixture",
      model: "actual-account-model",
      choices: [{ finish_reason: "stop", message: { content: reply } }],
      usage: { prompt_tokens: 12, completion_tokens: 8 },
    });
  });

  it("handles UTF-8, CRLF, comments and multiline data split across individual bytes", async () => {
    const multiline = JSON.stringify(completed(), null, 2)
      .split("\n")
      .map((line) => `data: ${line}`)
      .join("\r\n");
    const bytes = encoder.encode(
      `: keepalive\r\nid: fixture\r\nevent: response.completed\r\n${multiline}\r\n\r\n`,
    );
    fixture(Array.from(bytes, (byte) => Uint8Array.of(byte)));
    const result = await providerFetch(config, request);
    expect((await result.json()).choices[0].message.content).toBe(reply);
  });

  it("accepts bare CR event delimiters and ignores partial deltas in favor of completed output", async () => {
    fixture([
      event({ type: "response.created" }, "\r"),
      event(
        {
          type: "response.output_text.delta",
          delta: "uncommitted partial output",
        },
        "\r",
      ),
      event(completed(), "\r"),
    ]);
    const result = await providerFetch(config, request);
    expect((await result.json()).choices[0].message.content).toBe(reply);
  });

  it.each([
    [
      "EOF after deltas",
      event({ type: "response.output_text.delta", delta: reply }),
    ],
    ["legacy done marker", "data: [DONE]\n\n"],
    ["unterminated completed event", `data: ${JSON.stringify(completed())}\n`],
  ])(
    "rejects %s without a dispatched response.completed",
    async (_name, stream) => {
      fixture([stream]);
      await expect(providerFetch(config, request)).rejects.toThrow(
        "without response.completed",
      );
    },
  );

  it.each([
    ["subscription_sharing_usage_limit_exceeded", 429],
    ["subscription_sharing_usage_unavailable", 503],
    ["subscription_sharing_user_not_eligible", 403],
    ["subscription_sharing_unsupported_capability", 400],
  ] as const)(
    "preserves streamed %s failure without returning partial output or switching providers",
    async (code, status) => {
      const { fetch, cancel } = fixture(
        [
          event({
            type: "response.output_text.delta",
            delta: "must not be saved",
          }),
          event({
            type: "response.failed",
            response: {
              error: {
                code,
                param: "model",
                message: "Synthetic provider diagnostic",
              },
            },
          }),
        ],
        true,
      );
      const result = await providerFetch(config, request);
      expect(result.status).toBe(status);
      expect(result.headers.get("x-request-id")).toBe("req_fixture");
      expect(await result.json()).toEqual({
        error: {
          code,
          param: "model",
          message: "Synthetic provider diagnostic",
        },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalled();
    },
  );

  it("handles explicit errors and incomplete output as non-successful terminal events", async () => {
    fixture([
      event({
        type: "error",
        code: "rate_limit_exceeded",
        param: null,
        message: "Wait",
      }),
    ]);
    expect((await providerFetch(config, request)).status).toBe(429);
    fixture([
      event({
        type: "response.incomplete",
        response: {
          incomplete_details: { reason: "max_output_tokens" },
          output: [],
        },
      }),
    ]);
    const incomplete = await providerFetch(config, request);
    expect(incomplete.ok).toBe(false);
    expect(await incomplete.json()).toMatchObject({
      error: { code: "response_incomplete" },
    });
  });

  it("keeps completed refusals separate from text and never supplies them as JSON output", async () => {
    const refusal = completed();
    const output = refusal.response.output[0];
    fixture([
      event({
        ...refusal,
        response: {
          ...refusal.response,
          output: [
            {
              ...output,
              content: [
                { type: "refusal", refusal: "I cannot complete that request." },
              ],
            },
          ],
        },
      }),
    ]);
    expect(await (await providerFetch(config, request)).json()).toMatchObject({
      choices: [
        {
          message: {
            content: null,
            refusal: "I cannot complete that request.",
          },
        },
      ],
    });
  });

  it.each([
    {
      ...completed(),
      response: { ...completed().response, status: "incomplete" },
    },
    {
      ...completed(),
      response: { ...completed().response, error: { code: "failed" } },
    },
    { ...completed(), response: { ...completed().response, output: [] } },
  ])(
    "rejects a malformed completed response instead of using prior deltas",
    async (terminal) => {
      fixture([
        event({ type: "response.output_text.delta", delta: reply }),
        event(terminal),
      ]);
      await expect(providerFetch(config, request)).rejects.toThrow();
    },
  );

  it("bounds cumulative bytes even when many earlier events have already been discarded", async () => {
    const { cancel } = fixture(
      Array.from({ length: 5 }, () => `:${"x".repeat(110_000)}\n\n`),
      true,
    );
    await expect(providerFetch(config, request)).rejects.toThrow("too large");
    expect(cancel).toHaveBeenCalled();
  });

  it("accepts exactly the byte budget and rejects one additional byte", async () => {
    const terminal = event(completed());
    const padding = 512_000 - encoder.encode(terminal).byteLength;
    fixture([`:${"x".repeat(padding - 3)}\n\n`, terminal]);
    expect((await providerFetch(config, request)).ok).toBe(true);
    fixture([`:${"x".repeat(padding - 2)}\n\n`, terminal]);
    await expect(providerFetch(config, request)).rejects.toThrow("too large");
  });

  it("cancels a stalled body when the caller aborts after HTTP headers", async () => {
    const { fetch, cancel } = fixture([], true);
    const controller = new AbortController();
    const promise = providerFetch(config, request, controller.signal);
    const rejected = expect(promise).rejects.toMatchObject({
      name: "AbortError",
    });
    await Promise.resolve();
    controller.abort();
    await rejected;
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalled();
  });

  it("keeps its timeout active through a stalled response body", async () => {
    const { cancel } = fixture([], true);
    await expect(
      providerFetch({ ...config, timeoutMs: 20 }, request),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(cancel).toHaveBeenCalled();
  });

  it("does not start inference for an already-cancelled caller", async () => {
    const { fetch } = fixture([event(completed())]);
    await expect(
      providerFetch(config, request, AbortSignal.abort()),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves non-200 admission responses for the safe HTTP error classifier", async () => {
    const response = Response.json(
      { detail: "Synthetic admission restriction" },
      { status: 403, headers: { "x-request-id": "req_denied" } },
    );
    const fetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetch);
    expect(await providerFetch(config, request)).toBe(response);
    expect(response.bodyUsed).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid UTF-8, event-name mismatches and non-streaming successes", async () => {
    fixture([Uint8Array.of(0xff)]);
    await expect(providerFetch(config, request)).rejects.toThrow();
    fixture([`event: response.failed\n${event(completed())}`]);
    await expect(providerFetch(config, request)).rejects.toThrow(
      "Invalid ChatGPT stream event",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json(completed().response)),
    );
    await expect(providerFetch(config, request)).rejects.toThrow(
      "event stream",
    );
  });
  it("does not include malformed provider payloads in parse errors", async () => {
    const { cancel } = fixture(["data: sensitive-provider-text\n\n"], true);
    await expect(providerFetch(config, request)).rejects.toThrow(
      /^Invalid ChatGPT stream JSON$/,
    );
    expect(cancel).toHaveBeenCalled();
  });
});
