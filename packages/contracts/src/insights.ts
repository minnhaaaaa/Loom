import { z } from "zod";
import type { Status } from "./index";

export const insightQuerySchema = z
  .object({
    days: z.union([z.literal(30), z.literal(90)]).default(30),
  })
  .strict();
export type InsightQuery = z.infer<typeof insightQuerySchema>;
export type ActiveStatus = Exclude<Status, "done" | "cancelled">;
export type PhaseInsight = {
  status: ActiveStatus;
  requestCount: number;
  totalHours: number;
  medianHours: number | null;
  p90Hours: number | null;
};
export type FlowInsight = {
  weekStart: string;
  incoming: number;
  completions: number;
  cancellations: number;
  reopens: number;
  endingBacklog: number;
};
export type OwnerInsight = {
  ownerId: string | null;
  ownerName: string;
  open: number;
  overdue: number;
  under7Days: number;
  days7To14: number;
  days14Plus: number;
  oldestHours: number;
};
export type InsightRecord = {
  id: string;
  title: string;
  newHours: number;
  needsInfoHours: number;
  readyHours: number;
  inProgressHours: number;
  firstEventVersion: number;
  lastEventVersion: number;
};
export type InsightQueryEvidence = {
  queryId: string;
  sqlHash: string;
  durationMs: number;
  returnedRows: number;
};
export type AnalyticsInsights = {
  workspaceId: string;
  days: 30 | 90;
  from: string;
  asOf: string;
  phases: PhaseInsight[];
  flow: FlowInsight[];
  owners: OwnerInsight[];
  records: InsightRecord[];
  hasMore: { owners: boolean; records: boolean };
  evidence: InsightQueryEvidence[];
  semantics: {
    period: string;
    duration: string;
    flow: string;
    workload: string;
  };
};
