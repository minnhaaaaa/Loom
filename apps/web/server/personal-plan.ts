import "server-only";
import type { Actor } from "@loom/contracts";
import { DomainError } from "@loom/domain";
import {
  getOpenAiPlanCredential,
  type OpenAiPlanStatus,
} from "./openai-oauth-store";
import {
  modelIdentity,
  type ProviderRuntimeConfig,
} from "./provider-transport";

export function personalPlanModel(plan: OpenAiPlanStatus) {
  return plan.model
    ? modelIdentity({
        provider: "openai-chatgpt",
        model: plan.model,
        revision: plan.revision,
        key: "",
        maxTokens: 4096,
        timeoutMs: 60_000,
        freeOnly: false,
      })
    : null;
}

// Resolve only after releasing the caller's SQL transaction: renewal has its
// own database lease and may contact OpenAI. Never substitute a paid API key.
export async function personalPlanRuntime(
  actor: Actor,
  expected: OpenAiPlanStatus,
): Promise<ProviderRuntimeConfig> {
  const credential = await getOpenAiPlanCredential(actor);
  if (
    !credential?.planEnabled ||
    !credential.model ||
    credential.clientId !== expected.clientId ||
    credential.subject !== expected.subject ||
    credential.revision !== expected.revision ||
    credential.model !== expected.model
  )
    throw new DomainError(
      "OPENAI_CONNECTION_CHANGED",
      "Your ChatGPT account, model, or permission changed. Reconnect in Company setup and send a new request.",
      409,
    );
  return {
    provider: "openai-chatgpt",
    model: credential.model,
    revision: credential.revision,
    key: credential.accessToken,
    maxTokens: 4096,
    timeoutMs: 60_000,
    freeOnly: false,
  };
}
