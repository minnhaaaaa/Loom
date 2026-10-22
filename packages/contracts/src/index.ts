import { z } from "zod";

export const statuses = [
  "new",
  "needs_info",
  "ready",
  "in_progress",
  "done",
  "cancelled",
] as const;
export const roles = ["owner", "operator", "requester", "viewer"] as const;
export const statusLabels: Record<Status, string> = {
  new: "New",
  needs_info: "Needs information",
  ready: "Ready",
  in_progress: "In progress",
  done: "Done",
  cancelled: "Cancelled",
};
export type Status = (typeof statuses)[number];
export type Role = (typeof roles)[number];
export const workspaceId = "11111111-1111-4111-8111-111111111111";
export const secondWorkspaceId = "22222222-2222-4222-8222-222222222222";
export const personas = [
  { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Ananya", role: "owner" },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    name: "Rohan",
    role: "operator",
  },
  {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    name: "Meera",
    role: "requester",
  },
  { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", name: "Dev", role: "viewer" },
] as const;
export type Actor = { userId: string; workspaceId: string };
export type Membership = { userId: string; name: string; role: Role };
const text = (max: number) => z.string().trim().min(1).max(max);
export const intakeSchema = z
  .object({
    title: text(160),
    businessQuestion: text(4000),
    reportingPeriod: z.string().trim().max(200).default(""),
    dataset: z.string().trim().max(200).default(""),
  })
  .strict();
export type Intake = z.infer<typeof intakeSchema>;
export const commandSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("set_status"), status: z.enum(statuses) })
    .strict(),
  z
    .object({ type: z.literal("set_owner"), ownerId: z.uuid().nullable() })
    .strict(),
  z
    .object({
      type: z.literal("set_priority"),
      priority: z.enum(["low", "normal", "high"]),
    })
    .strict(),
  z
    .object({ type: z.literal("set_due_date"), dueAt: z.iso.date().nullable() })
    .strict(),
  z
    .object({ type: z.literal("edit_description"), values: intakeSchema })
    .strict(),
  z
    .object({
      type: z.literal("add_comment"),
      body: text(4000),
      visibility: z.enum(["internal", "requester_visible"]),
    })
    .strict(),
]);
export type Command = z.infer<typeof commandSchema>;
export const createSchema = z
  .object({ commandId: z.uuid(), values: intakeSchema })
  .strict();
export const mutationSchema = z
  .object({
    commandId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    command: commandSchema,
  })
  .strict();
export type RequestRecord = Intake & {
  id: string;
  workspaceId: string;
  requesterId: string;
  requesterName: string;
  ownerId: string | null;
  ownerName: string | null;
  priority: "low" | "normal" | "high";
  status: Status;
  dueAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};
export type CommentRecord = {
  id: string;
  authorName: string;
  body: string;
  visibility: "internal" | "requester_visible";
  createdAt: string;
};
export type ActivityRecord = {
  id: string;
  actorName: string;
  action: string;
  version: number;
  createdAt: string;
};
export type RequestDetails = {
  request: RequestRecord;
  comments: CommentRecord[];
  activity: ActivityRecord[];
};
export type PublicRequest = Omit<RequestRecord, "priority"> & {
  priority?: RequestRecord["priority"];
};
export const deskQuerySchema = z
  .object({
    search: z.string().trim().max(200).default(""),
    status: z.enum(["all", ...statuses]).default("all"),
    page: z.coerce.number().int().min(0).max(4000).default(0),
  })
  .strict();
export type DeskQuery = z.infer<typeof deskQuerySchema>;
export type DeskSnapshot = {
  page?: { index: number; size: number; hasMore: boolean };
  mode: "preview" | "connected";
  membership: Membership | null;
  requests: PublicRequest[];
  members: Membership[];
};
export const toolSpec = {
  schemaVersion: 1,
  templateId: "request-desk",
  title: "Data requests",
  fields: [
    {
      id: "title",
      label: "Request title",
      type: "text",
      requiredAt: "intake",
      maxLength: 160,
    },
    {
      id: "businessQuestion",
      label: "Business question",
      type: "textarea",
      requiredAt: "intake",
      maxLength: 4000,
    },
    {
      id: "reportingPeriod",
      label: "Reporting period",
      type: "text",
      requiredAt: "ready",
      maxLength: 200,
    },
    {
      id: "dataset",
      label: "Dataset",
      type: "text",
      requiredAt: "ready",
      maxLength: 200,
    },
  ],
  views: [
    { id: "queue", component: "request-table" },
    { id: "intake", component: "request-form" },
  ],
} as const;
export type AnalyticsResult = {
  queryId: "queue-summary-v1";
  queriedAt: string;
  open: number;
  overdue: number;
  unassigned: number;
  incomplete: number;
  oldestAgeDays: number;
  rowCount: number;
};

export const csvMappingSchema = z
  .object({
    title: z.number().int().min(0).max(19).nullable(),
    businessQuestion: z.number().int().min(0).max(19).nullable(),
    reportingPeriod: z.number().int().min(0).max(19).nullable(),
    dataset: z.number().int().min(0).max(19).nullable(),
  })
  .strict();
export const csvPreviewSchema = z
  .object({
    text: z.string().max(5 * 1024 * 1024),
    mapping: csvMappingSchema.optional(),
  })
  .strict();
export const csvCommitSchema = z
  .object({
    batchId: z.uuid(),
    previewHash: z.string().regex(/^[a-f0-9]{64}$/),
    commandId: z.uuid(),
  })
  .strict();
