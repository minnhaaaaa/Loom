import { z } from "zod";
import type { ModelInference, TriageProposal } from "./index";
import type { ToolDraft } from "./tools";

export const conversationSendSchema = z
  .object({
    commandId: z.uuid(),
    prompt: z.string().trim().min(1).max(4000),
  })
  .strict();
export type ConversationSend = z.infer<typeof conversationSendSchema>;
export type ConversationCitation = {
  id: string;
  title: string;
  version: number;
};
export type ConversationMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  state: "pending" | "complete" | "failed";
  citations?: ConversationCitation[];
  proposals?: TriageProposal[];
  toolDraft?: ToolDraft;
  inference?: ModelInference;
};
export type ConversationConfiguration = {
  configured: boolean;
  mode: "builtin" | "external" | "unavailable";
  provider: "loom" | "codex" | "claude-code" | "other";
  model: string | null;
  message: string;
};
export type ConversationSnapshot = {
  messages: ConversationMessage[];
  configuration: ConversationConfiguration;
  hasMore: boolean;
};
