import "server-only";
import { z } from "zod";
import { DomainError } from "@loom/domain";
import type { CompanyProvider } from "@loom/contracts";
import { chatgptFetch } from "./chatgpt-transport";

export type ProviderRuntimeConfig = {
  provider?: CompanyProvider | "openrouter" | "openai-chatgpt";
  key: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  freeOnly: boolean;
  reasoningEnabled?: boolean;
  revision?: number;
};
export type ProviderRequest = {
  model?: string;
  system: string;
  input: string;
  schemaName: string;
  schema: unknown;
};
const endpoints = {
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  openai: "https://api.openai.com/v1/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages",
  kimi: "https://api.moonshot.ai/v1/chat/completions",
  deepseek: "https://api.deepseek.com/chat/completions",
} as const;
export function modelIdentity(config: ProviderRuntimeConfig) {
  return config.revision === undefined
    ? config.model
    : `${config.provider}:${config.model}@${config.revision}`;
}
export async function boundedProviderBody(
  response: Response,
  limit = response.ok ? 512_000 : 8192,
): Promise<unknown> {
  if (!response.body) throw new Error("Missing provider body");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > limit) {
        await reader.cancel();
        throw new Error("Provider response too large");
      }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    reader.releaseLock();
  }
}
export async function providerFetch(
  config: ProviderRuntimeConfig,
  request: ProviderRequest,
  signal?: AbortSignal,
): Promise<Response> {
  const provider = config.provider || "openrouter",
    model = request.model || config.model;
  if (provider === "openai-chatgpt")
    return chatgptFetch(config, request, signal);
  if (!Object.hasOwn(endpoints, provider))
    throw new DomainError(
      "MODEL_CONFIGURATION",
      "Choose a supported provider.",
      503,
    );
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  let body: Record<string, unknown>;
  if (provider === "anthropic") {
    headers["x-api-key"] = config.key;
    headers["anthropic-version"] = "2023-06-01";
    body = {
      model,
      max_tokens: config.maxTokens,
      system: request.system,
      messages: [{ role: "user", content: request.input }],
      tools: [
        {
          name: request.schemaName,
          description:
            "Return the requested structured response. This only formats output and does not execute an action.",
          input_schema: request.schema,
        },
      ],
      tool_choice: { type: "tool", name: request.schemaName },
    };
  } else {
    headers.Authorization = `Bearer ${config.key}`;
    const jsonOnly = provider === "kimi" || provider === "deepseek";
    body = {
      model,
      stream: false,
      ...(provider === "openai"
        ? { max_completion_tokens: config.maxTokens, store: false }
        : { max_tokens: config.maxTokens }),
      messages: [
        {
          role: "system",
          content:
            request.system +
            (jsonOnly
              ? `\nReturn a JSON object matching this schema: ${JSON.stringify(request.schema)}`
              : ""),
        },
        { role: "user", content: request.input },
      ],
      response_format: jsonOnly
        ? { type: "json_object" }
        : {
            type: "json_schema",
            json_schema: {
              name: request.schemaName,
              strict: true,
              schema: request.schema,
            },
          },
    };
    if (provider === "openrouter") {
      headers["X-OpenRouter-Title"] = "Loom";
      body.provider = {
        require_parameters: true,
        data_collection: "deny",
        ...(config.freeOnly
          ? { max_price: { prompt: 0, completion: 0, request: 0 } }
          : {}),
      };
      if (config.reasoningEnabled !== undefined)
        body.reasoning = { enabled: config.reasoningEnabled };
    }
  }
  const response = await fetch(endpoints[provider], {
    method: "POST",
    redirect: "error",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.any([
      AbortSignal.timeout(config.timeoutMs),
      ...(signal ? [signal] : []),
    ]),
  });
  if (provider !== "anthropic" || !response.ok) return response;
  const value = z
    .object({
      id: z.string().max(200),
      model: z.string().max(200),
      stop_reason: z.string().nullable(),
      content: z.array(
        z.object({
          type: z.string(),
          name: z.string().optional(),
          input: z.unknown().optional(),
        }),
      ),
      usage: z
        .object({
          input_tokens: z.number().int().nonnegative(),
          output_tokens: z.number().int().nonnegative(),
        })
        .optional(),
    })
    .parse(await boundedProviderBody(response));
  const blocks = value.content.filter(
    (block) => block.type === "tool_use" && block.name === request.schemaName,
  );
  return Response.json({
    id: value.id,
    model: value.model,
    choices: [
      {
        finish_reason:
          value.stop_reason === "max_tokens"
            ? "length"
            : value.stop_reason === "tool_use" && blocks.length === 1
              ? "stop"
              : "incomplete",
        message: {
          content: blocks.length === 1 ? JSON.stringify(blocks[0].input) : null,
        },
      },
    ],
    usage: {
      prompt_tokens: value.usage?.input_tokens,
      completion_tokens: value.usage?.output_tokens,
    },
  });
}
