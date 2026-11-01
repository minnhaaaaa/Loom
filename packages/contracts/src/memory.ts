import { z } from "zod";
import type { KnowledgeEntry } from "./index";

export const memoryQuerySchema = z
  .object({
    q: z.string().trim().max(200).default(""),
    kind: z
      .enum(["all", "procedure", "glossary", "routing", "reference"])
      .default("all"),
    dataset: z.string().trim().max(200).default(""),
    ownerId: z.uuid().optional(),
    asOf: z.iso.date().optional(),
  })
  .strict();
export type MemoryQuery = z.infer<typeof memoryQuerySchema>;
export type KnowledgeMatch = {
  entry: KnowledgeEntry;
  score: number;
  matchedBy: ("exact" | "keyword" | "metadata" | "recent")[];
};
export type MemoryNode = {
  id: string;
  kind: "request" | "person" | "knowledge" | "proposal";
  label: string;
  version?: number;
  state?: string;
};
export type MemoryEdge = {
  id: string;
  from: string;
  to: string;
  relation:
    | "requested_by"
    | "assigned_to"
    | "owner_context"
    | "authored_by"
    | "imported_by"
    | "approved_by"
    | "cites"
    | "proposes_for"
    | "supersedes"
    | "learned_from";
  evidence: {
    resourceId: string;
    version: number;
    source: "request-record" | "knowledge-record" | "proposal-record";
    targetVersion?: number;
  };
};
export type MemoryTimelineEvent = {
  id: string;
  resourceId: string;
  actorName: string;
  action: string;
  version: number;
  createdAt: string;
};
export type TeamMemorySnapshot = {
  queriedAt: string;
  asOf: string;
  query: MemoryQuery;
  entries: KnowledgeMatch[];
  graph: { nodes: MemoryNode[]; edges: MemoryEdge[] };
  timeline: MemoryTimelineEvent[];
  limits: {
    knowledge: number;
    requests: number;
    proposals: number;
    events: number;
  };
  hasMore: {
    knowledge: boolean;
    requests: boolean;
    proposals: boolean;
    events: boolean;
  };
};
