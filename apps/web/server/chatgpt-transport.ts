import "server-only";
import { z } from "zod";
import type {
  ProviderRequest,
  ProviderRuntimeConfig,
} from "./provider-transport";

const streamLimit = 512_000;
const completedSchema = z.object({
  id: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
  status: z.literal("completed"),
  error: z.null().optional(),
  incomplete_details: z.null().optional(),
  output: z.array(
    z.object({
      type: z.string(),
      role: z.string().optional(),
      status: z.string().optional(),
      content: z
        .array(
          z.object({
            type: z.string(),
            text: z.string().max(100_000).optional(),
            refusal: z.string().max(100_000).optional(),
          }),
        )
        .optional(),
    }),
  ),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
    })
    .nullish(),
});

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function headersFor(response: Response) {
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const name of ["x-request-id", "retry-after"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function failedResponse(value: unknown, response: Response, fallback: string) {
  const error = object(value);
  const code =
    typeof error.code === "string" && error.code.length <= 200
      ? error.code
      : fallback;
  // Preserve plan-usage failures as failures; never retry against another biller.
  const statuses: Record<string, number> = {
    subscription_sharing_user_not_eligible: 403,
    subscription_sharing_usage_limit_exceeded: 429,
    subscription_sharing_usage_unavailable: 503,
    subscription_sharing_unsupported_capability: 400,
    subscription_sharing_route_not_supported: 403,
    subscription_sharing_invalid_user: 401,
    chatpass_v2_scope_not_authorized: 403,
    chatpass_v2_invalid_authorization_context: 403,
    subscription_sharing_user_unavailable: 503,
    rate_limit_exceeded: 429,
    invalid_api_key: 401,
  };
  return Response.json(
    {
      error: {
        code,
        param:
          typeof error.param === "string" && error.param.length <= 200
            ? error.param
            : null,
        message:
          typeof error.message === "string" && error.message.length <= 2000
            ? error.message
            : "ChatGPT could not complete this response.",
      },
    },
    { status: statuses[code] || 502, headers: headersFor(response) },
  );
}

function completedResponse(value: unknown, response: Response) {
  const parsed = completedSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid completed ChatGPT response");
  const result = parsed.data;
  let content = "",
    refusal: string | undefined;
  for (const item of result.output) {
    if (item.type !== "message") continue;
    if (
      item.role !== "assistant" ||
      (item.status && item.status !== "completed") ||
      !item.content
    )
      throw new Error("Incomplete ChatGPT output message");
    for (const part of item.content) {
      if (part.type === "refusal") {
        refusal = part.refusal || "The model declined this request.";
      } else if (part.type === "output_text" && typeof part.text === "string") {
        content += part.text;
      } else {
        throw new Error("Unexpected ChatGPT output content");
      }
    }
  }
  if ((!content && !refusal) || content.length > 100_000)
    throw new Error("Missing or oversized completed ChatGPT output");
  return Response.json(
    {
      id: result.id,
      model: result.model,
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: refusal ? null : content,
            ...(refusal ? { refusal } : {}),
          },
        },
      ],
      ...(result.usage
        ? {
            usage: {
              prompt_tokens: result.usage.input_tokens,
              completion_tokens: result.usage.output_tokens,
            },
          }
        : {}),
    },
    { headers: headersFor(response) },
  );
}

async function consumeStream(response: Response, signal: AbortSignal) {
  if (
    !response.body ||
    !/^text\/event-stream(?:;|$)/i.test(
      response.headers.get("content-type") || "",
    )
  )
    throw new Error("ChatGPT did not return an event stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    pending = "",
    data: string[] = [],
    eventName = "";
  let terminal: Response | undefined;
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });

  function line(value: string) {
    if (value === "") {
      const payload = data.join("\n"),
        name = eventName;
      data = [];
      eventName = "";
      if (!payload) return;
      if (payload === "[DONE]")
        throw new Error("ChatGPT stream ended without response.completed");
      let value: unknown;
      try {
        value = JSON.parse(payload);
      } catch {
        throw new Error("Invalid ChatGPT stream JSON");
      }
      const event = object(value);
      if (typeof event.type !== "string" || (name && name !== event.type))
        throw new Error("Invalid ChatGPT stream event");
      if (event.type === "response.completed") {
        terminal = completedResponse(event.response, response);
      } else if (event.type === "response.failed") {
        terminal = failedResponse(
          object(event.response).error,
          response,
          "response_failed",
        );
      } else if (event.type === "response.incomplete") {
        terminal = failedResponse({}, response, "response_incomplete");
      } else if (event.type === "error") {
        terminal = failedResponse(
          event.error || event,
          response,
          "response_error",
        );
      }
      return;
    }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const field = colon < 0 ? value : value.slice(0, colon);
    const raw = colon < 0 ? "" : value.slice(colon + 1);
    const text = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "data") data.push(text);
    else if (field === "event") eventName = text;
  }

  function consume(text: string, final = false) {
    pending += text;
    let start = 0;
    for (let i = 0; i < pending.length; i++) {
      const char = pending[i];
      // A CR at the chunk boundary may be the first half of CRLF.
      if (char === "\r" && i === pending.length - 1 && !final) break;
      if (char !== "\r" && char !== "\n") continue;
      line(pending.slice(start, i));
      if (terminal) return;
      if (char === "\r" && pending[i + 1] === "\n") i++;
      start = i + 1;
    }
    pending = pending.slice(start);
  }

  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) {
        consume(decoder.decode(), true);
        if (terminal) return terminal;
        throw new Error("ChatGPT stream ended without response.completed");
      }
      bytes += chunk.value.byteLength;
      if (bytes > streamLimit)
        throw new Error("ChatGPT event stream too large");
      consume(decoder.decode(chunk.value, { stream: true }));
      if (terminal) return terminal;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    // Cancel on terminal events and all failure paths, including a stalled body.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** ChatGPT plan usage uses Responses SSE; a text delta is never a saved result. */
export async function chatgptFetch(
  config: ProviderRuntimeConfig,
  request: ProviderRequest,
  callerSignal?: AbortSignal,
): Promise<Response> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(config.timeoutMs),
    ...(callerSignal ? [callerSignal] : []),
  ]);
  signal.throwIfAborted();
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${config.key}`,
    },
    body: JSON.stringify({
      model: config.model,
      store: false,
      stream: true,
      max_output_tokens: config.maxTokens,
      input: [
        { role: "system", content: request.system },
        { role: "user", content: request.input },
      ],
      text: {
        format: {
          type: "json_schema",
          name: request.schemaName,
          strict: true,
          schema: request.schema,
        },
      },
    }),
    signal,
  });
  // Preserve HTTP failures (including non-standard admission bodies) for callers.
  if (response.status !== 200) return response;
  return consumeStream(response, signal);
}
