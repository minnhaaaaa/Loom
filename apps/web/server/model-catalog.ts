import "server-only";
import { z } from "zod";
import { DomainError } from "@loom/domain";
import type { CompanyProvider, ModelChoice } from "@loom/contracts";
import { boundedProviderBody } from "./provider-transport";

const endpoints: Record<CompanyProvider, string> = {
  openai: "https://api.openai.com/v1/models",
  anthropic: "https://api.anthropic.com/v1/models",
  kimi: "https://api.moonshot.ai/v1/models",
  deepseek: "https://api.deepseek.com/models",
};
const id = z.string().regex(/^[A-Za-z0-9._:/-]{1,200}$/);
const catalogSchema = z.object({
  data: z
    .array(
      z.object({
        id,
        display_name: z.string().max(200).optional(),
        name: z.string().max(200).optional(),
        lifecycle: z.string().optional(),
        shutdown_date: z.string().nullable().optional(),
      }),
    )
    .max(2000),
  has_more: z.boolean().optional(),
  last_id: id.nullable().optional(),
});
const chatgptSchema = z.object({
  models: z
    .array(
      z.object({
        slug: id,
        display_name: z.string().min(1).max(200),
        visibility: z.string(),
      }),
    )
    .max(2000),
});

/** Only catalogue GETs. Keys stay server-side; no inference, redirects or fallback. */
export async function fetchModelCatalog(
  provider: CompanyProvider,
  key: string,
  chatgpt = false,
): Promise<ModelChoice[]> {
  if (!Object.hasOwn(endpoints, provider) || (chatgpt && provider !== "openai"))
    throw new DomainError(
      "MODEL_CONFIGURATION",
      "Choose a supported provider.",
      400,
    );
  const headers: Record<string, string> =
    provider === "anthropic"
      ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
      : { Authorization: `Bearer ${key}` };
  const choices = new Map<string, ModelChoice>();
  const url = new URL(endpoints[provider]);
  if (provider === "anthropic") url.searchParams.set("limit", "1000");
  const signal = AbortSignal.timeout(15_000);
  try {
    for (let page = 0; page < 5; page++) {
      const response = await fetch(url.href, {
        method: "GET",
        headers,
        redirect: "error",
        cache: "no-store",
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        const unauthorized = response.status === 401 || response.status === 403;
        throw new DomainError(
          "MODEL_CATALOG_UNAVAILABLE",
          unauthorized
            ? chatgpt
              ? "Reconnect ChatGPT to load your models."
              : "Check your API key and its model-list permission."
            : "Models could not be loaded. Try again shortly.",
          unauthorized ? 403 : 503,
        );
      }
      const body = await boundedProviderBody(response, 1_000_000);
      if (chatgpt) {
        for (const model of chatgptSchema.parse(body).models)
          if (model.visibility === "list")
            choices.set(model.slug, {
              id: model.slug,
              name: model.display_name,
            });
        return [...choices.values()];
      }
      const catalog = catalogSchema.parse(body);
      for (const model of catalog.data) {
        if (
          model.id.length > 150 ||
          model.lifecycle === "retired" ||
          (model.shutdown_date && Date.parse(model.shutdown_date) <= Date.now())
        )
          continue;
        // These non-text APIs cannot serve Loom's structured request workflow.
        if (
          provider === "openai" &&
          /embedding|whisper|tts|dall-e|image|audio|realtime|transcribe|moderation|sora/i.test(
            model.id,
          )
        )
          continue;
        choices.set(model.id, {
          id: model.id,
          name: model.display_name || model.name || model.id,
        });
      }
      if (!catalog.has_more) return [...choices.values()];
      if (
        provider !== "anthropic" ||
        !catalog.last_id ||
        url.searchParams.get("after_id") === catalog.last_id
      )
        throw new Error("Invalid pagination");
      url.searchParams.set("after_id", catalog.last_id);
    }
    throw new Error("Catalog limit exceeded");
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      "MODEL_CATALOG_UNAVAILABLE",
      "Models could not be loaded. Try again shortly.",
      503,
    );
  }
}
