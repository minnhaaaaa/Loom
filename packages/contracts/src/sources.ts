import { z } from "zod";

export const sourceProviderSchema = z.enum([
  "slack",
  "teams",
  "sharepoint",
  "discord",
  "github",
]);
export type SourceProvider = z.infer<typeof sourceProviderSchema>;
export const externalSourceSchema = z
  .object({
    provider: sourceProviderSchema,
    sourceId: z.uuid(),
    externalId: z.string().min(1).max(300),
    url: z.url().max(2000),
    author: z.string().max(160),
    updatedAt: z.string().max(80),
    truncated: z.boolean(),
    page: z.number().int().positive().optional(),
    part: z.number().int().positive().optional(),
  })
  .strict();
export type ExternalSource = z.infer<typeof externalSourceSchema>;
export const sourceSelectionSchema = z
  .object({
    provider: sourceProviderSchema,
    rootId: z.string().trim().min(1).max(300),
    parentId: z.string().trim().max(300).default(""),
    shareWithWorkspace: z.literal(true),
    requestMode: z.enum(["detect", "all"]).default("detect"),
  })
  .strict();
export type SourceSelection = z.input<typeof sourceSelectionSchema>;
export type SourceOption = { id: string; name: string };
export type SourceStatus = {
  id: string;
  provider: SourceProvider;
  name: string;
  active: boolean;
  lastSyncedAt: string | null;
  nextSyncAt: string;
  error: string | null;
  imported: number;
  skipped: number;
  syncing: boolean;
  requestMode: "detect" | "all";
  reviewCount: number;
  review: {
    externalId: string;
    hash: string;
    title: string;
    text: string;
    url: string;
    reason: string;
  }[];
  issues: { title: string; reason: string }[];
};
export type SourceSnapshot = {
  microsoftAvailable: boolean;
  syncEnabled: boolean;
  connections: {
    provider: "slack" | "microsoft" | "discord" | "github";
    name: string;
    version: number;
  }[];
  sources: SourceStatus[];
};
