import { z } from "zod";

export const companyProviders = [
  "openai",
  "anthropic",
  "kimi",
  "deepseek",
] as const;
export type CompanyProvider = (typeof companyProviders)[number];
export type ModelChoice = { id: string; name: string };
export const providerModelsInputSchema = z
  .object({
    provider: z.enum(companyProviders),
    apiKey: z
      .string()
      .trim()
      .min(10)
      .max(4096)
      .regex(/^[\x21-\x7E]+$/)
      .optional(),
  })
  .strict();
export const providerLabels: Record<CompanyProvider, string> = {
  openai: "OpenAI API",
  anthropic: "Claude API",
  kimi: "Kimi API",
  deepseek: "DeepSeek API",
};
export const providerSettingsInputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("test-and-save"),
      commandId: z.uuid(),
      expectedVersion: z.number().int().nonnegative(),
      provider: z.enum(companyProviders),
      model: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9._:/-]{1,150}$/),
      apiKey: z
        .string()
        .trim()
        .min(10)
        .max(4096)
        .regex(/^[\x21-\x7E]+$/),
      maxTokens: z.number().int().min(256).max(8192),
      acknowledgeCharges: z.literal(true),
    })
    .strict(),
  z
    .object({
      action: z.literal("revoke"),
      commandId: z.uuid(),
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
]);
export type ProviderSettingsInput = z.infer<typeof providerSettingsInputSchema>;
export type ProviderSettingsSnapshot = {
  available: boolean;
  message: string;
  version: number;
  active: boolean;
  provider: CompanyProvider | null;
  model: string | null;
  maxTokens: number;
  testedAt: string | null;
  updatedAt: string | null;
};
