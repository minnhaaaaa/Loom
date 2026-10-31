import { z } from "zod";
import type { Intake, ModelInference } from "./index";

export const toolActionIds = [
  "request.create",
  "request.edit_description",
  "request.set_owner",
  "request.set_priority",
  "request.set_due_date",
  "request.set_status",
  "request.add_comment",
] as const;
export type ToolAction = (typeof toolActionIds)[number];
export const toolMetrics = [
  "open",
  "overdue",
  "unassigned",
  "incomplete",
] as const;
export const toolSystemColumns = [
  "title",
  "businessQuestion",
  "reportingPeriod",
  "dataset",
  "requesterName",
  "ownerName",
  "status",
  "dueAt",
  "priority",
  "createdAt",
] as const;
const coreFields = {
  title: { type: "text", maxLength: 160, requiredAt: "intake" },
  businessQuestion: { type: "textarea", maxLength: 4000, requiredAt: "intake" },
  reportingPeriod: { type: "text", maxLength: 200, requiredAt: "ready" },
  dataset: { type: "text", maxLength: 200, requiredAt: "ready" },
} as const;
const label = z.string().trim().min(1).max(160);
export const toolFieldSchema = z
  .object({
    id: z.string().min(1).max(64),
    label,
    type: z.enum(["text", "textarea"]),
    requiredAt: z.enum(["intake", "ready", "optional"]),
    maxLength: z.number().int().min(1).max(4000),
    visible: z.boolean(),
  })
  .strict();
export type ToolField = z.infer<typeof toolFieldSchema>;
export const toolViewSchema = z.discriminatedUnion("id", [
  z
    .object({
      id: z.literal("queue"),
      component: z.literal("request-table"),
      columns: z.array(z.string().min(1).max(64)).min(1).max(18),
    })
    .strict(),
  z
    .object({ id: z.literal("intake"), component: z.literal("request-form") })
    .strict(),
  z
    .object({
      id: z.literal("details"),
      component: z.literal("request-details"),
    })
    .strict(),
  z
    .object({
      id: z.literal("filters"),
      component: z.literal("request-filters"),
      search: z.boolean(),
      status: z.boolean(),
    })
    .strict(),
  z
    .object({
      id: z.literal("summary"),
      component: z.literal("request-summary"),
      metrics: z.array(z.enum(toolMetrics)).max(4),
    })
    .strict(),
]);
export type ToolView = z.infer<typeof toolViewSchema>;
export const toolSpecSchema = z
  .object({
    schemaVersion: z.literal(1),
    templateId: z.literal("request-desk"),
    title: label,
    description: z.string().trim().max(1000),
    fields: z.array(toolFieldSchema).min(4).max(12),
    views: z.array(toolViewSchema).length(5),
    actions: z.array(z.enum(toolActionIds)).min(1).max(toolActionIds.length),
    statusLabels: z
      .object({
        new: label,
        needs_info: label,
        ready: label,
        in_progress: label,
        done: label,
        cancelled: label,
      })
      .strict(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    const unique = (
      values: string[],
      path: (string | number)[],
      name: string,
    ) => {
      if (new Set(values).size !== values.length)
        issue(path, `${name} must be unique.`);
    };
    unique(
      spec.fields.map((field) => field.id),
      ["fields"],
      "Field IDs",
    );
    unique(
      spec.views.map((view) => view.id),
      ["views"],
      "View IDs",
    );
    unique(spec.actions, ["actions"], "Action IDs");
    for (const [id, core] of Object.entries(coreFields)) {
      const field = spec.fields.find((candidate) => candidate.id === id);
      if (!field) {
        issue(["fields"], `The core field ${id} is required.`);
        continue;
      }
      if (field.type !== core.type || field.maxLength !== core.maxLength)
        issue(
          ["fields"],
          `Core field ${id} must retain its type and maximum length.`,
        );
      if (
        (core.requiredAt === "intake" && field.requiredAt !== "intake") ||
        field.requiredAt === "optional"
      )
        issue(
          ["fields"],
          `Core field ${id} must remain required at ${core.requiredAt}.`,
        );
    }
    let customCount = 0;
    spec.fields.forEach((field, index) => {
      if (!Object.hasOwn(coreFields, field.id)) {
        customCount++;
        if (!/^custom_[a-z][a-z0-9_]{0,31}$/.test(field.id))
          issue(
            ["fields", index, "id"],
            "Custom field IDs must use the custom_ prefix and lower snake case.",
          );
        if (field.maxLength > 2000)
          issue(
            ["fields", index, "maxLength"],
            "Custom fields support at most 2000 characters.",
          );
        if (field.requiredAt === "intake")
          issue(
            ["fields", index, "requiredAt"],
            "Custom intake requirements require a backfill strategy and are not supported.",
          );
      }
      if (field.requiredAt !== "optional" && !field.visible)
        issue(
          ["fields", index, "visible"],
          "Required fields must remain visible.",
        );
    });
    if (customCount > 8)
      issue(["fields"], "At most eight custom fields are supported.");
    const columns = new Set<string>([
      ...toolSystemColumns,
      ...spec.fields.map((field) => field.id),
    ]);
    for (const [index, view] of spec.views.entries()) {
      if (view.id === "queue") {
        unique(view.columns, ["views", index, "columns"], "Queue columns");
        if (!view.columns.includes("title"))
          issue(
            ["views", index, "columns"],
            "The queue must include the title column.",
          );
        view.columns.forEach((column, columnIndex) => {
          if (!columns.has(column))
            issue(
              ["views", index, "columns", columnIndex],
              `Unknown field reference: ${column}.`,
            );
        });
      }
      if (view.id === "summary")
        unique(view.metrics, ["views", index, "metrics"], "Summary metrics");
    }
  });
export type ToolSpec = z.infer<typeof toolSpecSchema>;
export type PublishedTool = {
  revision: number;
  spec: ToolSpec;
  publishedAt: string | null;
};
export type ToolDraft = {
  id: string;
  baseRevision: number;
  spec: ToolSpec;
  instructions: string;
  assumptions: string[];
  unsupported: string[];
  hash: string;
  createdAt: string;
  inference?: ModelInference;
};
export type ToolWorkspace = {
  published: PublishedTool;
  drafts: ToolDraft[];
  history: PublishedTool[];
  configuration: {
    configured: boolean;
    model: string | null;
    message: string;
    freeOnly?: boolean;
  };
};
export const createToolDraftSchema = z
  .object({
    commandId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    spec: toolSpecSchema,
    instructions: z.string().trim().max(4000).default(""),
  })
  .strict();
export const publishToolSchema = z
  .object({
    commandId: z.uuid(),
    draftId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const generateToolSchema = z
  .object({
    commandId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    instructions: z.string().trim().min(1).max(4000),
    baseSpec: toolSpecSchema,
  })
  .strict();

export const dataRequestTemplate: ToolSpec = toolSpecSchema.parse({
  schemaVersion: 1,
  templateId: "request-desk",
  title: "Data requests",
  description:
    "Collect complete analytics requests, clarify requirements, and track delivery.",
  fields: [
    {
      id: "title",
      label: "Request title",
      type: "text",
      requiredAt: "intake",
      maxLength: 160,
      visible: true,
    },
    {
      id: "businessQuestion",
      label: "Business question",
      type: "textarea",
      requiredAt: "intake",
      maxLength: 4000,
      visible: true,
    },
    {
      id: "reportingPeriod",
      label: "Reporting period",
      type: "text",
      requiredAt: "ready",
      maxLength: 200,
      visible: true,
    },
    {
      id: "dataset",
      label: "Dataset",
      type: "text",
      requiredAt: "ready",
      maxLength: 200,
      visible: true,
    },
  ],
  views: [
    {
      id: "queue",
      component: "request-table",
      columns: ["title", "status", "ownerName", "dueAt", "priority"],
    },
    { id: "intake", component: "request-form" },
    { id: "details", component: "request-details" },
    { id: "filters", component: "request-filters", search: true, status: true },
    { id: "summary", component: "request-summary", metrics: [...toolMetrics] },
  ],
  actions: [...toolActionIds],
  statusLabels: {
    new: "New",
    needs_info: "Needs information",
    ready: "Ready",
    in_progress: "In progress",
    done: "Done",
    cancelled: "Cancelled",
  },
});
export const itRequestTemplate: ToolSpec = toolSpecSchema.parse({
  ...dataRequestTemplate,
  title: "IT requests",
  description:
    "Collect support requests, identify the affected service, and track resolution.",
  fields: dataRequestTemplate.fields.map((field) => ({
    ...field,
    label: (
      {
        title: "Issue title",
        businessQuestion: "What do you need help with?",
        reportingPeriod: "Needed for",
        dataset: "System or service",
      } as Record<string, string>
    )[field.id],
  })),
});

export const onboardingTemplate: ToolSpec = toolSpecSchema.parse({
  ...dataRequestTemplate,
  title: "Employee onboarding",
  description:
    "Prepare for new joiners, record onboarding tasks, and track what still needs attention.",
  fields: [
    ...dataRequestTemplate.fields.map((field) => ({
      ...field,
      label: (
        {
          title: "Employee name",
          businessQuestion: "Onboarding plan",
          reportingPeriod: "Joining date",
          dataset: "Team or department",
        } as Record<string, string>
      )[field.id],
    })),
    {
      id: "custom_buddy",
      label: "Assigned buddy",
      type: "text",
      requiredAt: "optional",
      maxLength: 200,
      visible: true,
    },
    {
      id: "custom_onboarding_tasks",
      label: "Onboarding tasks and progress",
      type: "textarea",
      requiredAt: "optional",
      maxLength: 2000,
      visible: true,
    },
  ],
  views: dataRequestTemplate.views.map((view) =>
    view.id === "queue"
      ? {
          ...view,
          columns: [
            "title",
            "reportingPeriod",
            "dataset",
            "custom_buddy",
            "status",
            "ownerName",
            "dueAt",
          ],
        }
      : view,
  ),
  statusLabels: {
    ...dataRequestTemplate.statusLabels,
    new: "Planned",
    needs_info: "Details needed",
    ready: "Ready to start",
    in_progress: "Onboarding",
    done: "Completed",
  },
});

export const projectReviewTemplate: ToolSpec = toolSpecSchema.parse({
  ...dataRequestTemplate,
  title: "Project reviews",
  description:
    "Collect review briefs, assign reviewers, and keep decisions and follow-up work together.",
  fields: [
    ...dataRequestTemplate.fields.map((field) => ({
      ...field,
      label: (
        {
          title: "Project or change",
          businessQuestion: "Review brief and decision needed",
          reportingPeriod: "Review window",
          dataset: "Team or workstream",
        } as Record<string, string>
      )[field.id],
    })),
    {
      id: "custom_review_context",
      label: "Supporting context",
      type: "textarea",
      requiredAt: "optional",
      maxLength: 2000,
      visible: true,
    },
    {
      id: "custom_review_outcome",
      label: "Decision and follow-up",
      type: "textarea",
      requiredAt: "optional",
      maxLength: 2000,
      visible: true,
    },
  ],
  views: dataRequestTemplate.views.map((view) =>
    view.id === "queue"
      ? {
          ...view,
          columns: [
            "title",
            "dataset",
            "status",
            "ownerName",
            "dueAt",
            "priority",
          ],
        }
      : view,
  ),
  statusLabels: {
    ...dataRequestTemplate.statusLabels,
    new: "Submitted",
    needs_info: "Context needed",
    ready: "Ready for review",
    in_progress: "In review",
    done: "Review complete",
  },
});

export type ProcessTemplateId = "data" | "it" | "onboarding" | "project-review";
export type ProcessTemplate = {
  id: ProcessTemplateId;
  label: string;
  description: string;
  prompt: string;
  spec: ToolSpec;
  sampleValues: Intake[];
};

// These public synthetic examples illustrate each vocabulary. They are preview
// values only; choosing a template never creates or rewrites business records.
export const processTemplates: ProcessTemplate[] = [
  {
    id: "data",
    label: "Data requests",
    description: "Collect analytics questions and track delivery.",
    prompt:
      "Build a data-request desk with requester, business question, reporting period, dataset, owner, priority, due date, and status. Show incomplete and overdue requests.",
    spec: dataRequestTemplate,
    sampleValues: [
      {
        title: "Weekly acquisition funnel",
        businessQuestion:
          "Where did new customers drop off between signup and their first order?",
        reportingPeriod: "Last 4 complete weeks",
        dataset: "Product events and orders",
      },
      {
        title: "Returns by product category",
        businessQuestion:
          "Which categories account for the largest share of returns?",
        reportingPeriod: "",
        dataset: "",
      },
      {
        title: "Refresh the operations scorecard",
        businessQuestion:
          "Update fulfillment and delivery measures for the operations review.",
        reportingPeriod: "Yesterday",
        dataset: "Fulfillment events",
      },
    ],
  },
  {
    id: "it",
    label: "IT requests",
    description: "Collect support issues and coordinate resolution.",
    prompt:
      "Build an IT support desk with issue title, help needed, needed-for period, affected system, owner, priority, due date, and status. Highlight incomplete and unassigned requests.",
    spec: itRequestTemplate,
    sampleValues: [
      {
        title: "Set up a new laptop",
        businessQuestion:
          "Prepare a laptop with the approved development tools and access.",
        reportingPeriod: "Before the first day",
        dataset: "Employee devices",
      },
      {
        title: "Cannot access a shared folder",
        businessQuestion:
          "Help me identify the right access request for my team's shared files.",
        reportingPeriod: "",
        dataset: "",
      },
      {
        title: "Restore meeting-room display",
        businessQuestion:
          "The display does not connect to laptops. Please investigate.",
        reportingPeriod: "This week",
        dataset: "Meeting-room equipment",
      },
    ],
  },
  {
    id: "onboarding",
    label: "Employee onboarding",
    description: "Prepare joiners, record tasks, and coordinate buddies.",
    prompt:
      "Build an employee onboarding tracker with employee name, onboarding plan, joining date, team, assigned buddy, tasks and progress, owner, due date, and status. Show incomplete and overdue onboarding records. Keep tasks as editable text; do not claim calendar or HR-system integrations.",
    spec: onboardingTemplate,
    sampleValues: [
      {
        title: "Aarav Shah",
        businessQuestion:
          "Prepare access, equipment, and a first-week introduction plan.",
        reportingPeriod: "2 November 2026",
        dataset: "Product design",
        customValues: {
          custom_buddy: "Priya",
          custom_onboarding_tasks:
            "Laptop: ready\nTeam introduction: scheduled\nTool access: waiting for approval",
        },
      },
      {
        title: "Leela Rao",
        businessQuestion:
          "Confirm the joining details before arranging the onboarding plan.",
        reportingPeriod: "",
        dataset: "",
        customValues: {
          custom_buddy: "",
          custom_onboarding_tasks: "Joining date and team need confirmation.",
        },
      },
      {
        title: "Kabir Das",
        businessQuestion:
          "Prepare the first-week support rotation and onboarding walkthrough.",
        reportingPeriod: "5 November 2026",
        dataset: "Customer operations",
        customValues: {
          custom_buddy: "Maya",
          custom_onboarding_tasks:
            "Equipment: ready\nBuddy: confirmed\nOrientation: ready to arrange",
        },
      },
    ],
  },
  {
    id: "project-review",
    label: "Project reviews",
    description: "Gather context, assign reviewers, and record decisions.",
    prompt:
      "Build a project-review desk with project name, review brief, review window, team, supporting context, decision and follow-up, reviewer, priority, due date, and status. Show reviews missing context and overdue work. Keep context as text and decisions under human review.",
    spec: projectReviewTemplate,
    sampleValues: [
      {
        title: "Checkout accessibility review",
        businessQuestion:
          "Review keyboard navigation and agree on the fixes needed before release.",
        reportingPeriod: "Next release review",
        dataset: "Commerce experience",
        customValues: {
          custom_review_context:
            "The design review identified focus-order and error-message issues.",
          custom_review_outcome: "Awaiting reviewer feedback.",
        },
      },
      {
        title: "Support handover proposal",
        businessQuestion:
          "Confirm responsibilities and escalation steps for the proposed handover.",
        reportingPeriod: "",
        dataset: "",
        customValues: {
          custom_review_context: "The receiving team has not confirmed scope.",
          custom_review_outcome: "",
        },
      },
      {
        title: "Weekly reporting change",
        businessQuestion:
          "Review the proposed reporting format and record the agreed follow-up.",
        reportingPeriod: "First week of November",
        dataset: "Operations reporting",
        customValues: {
          custom_review_context:
            "The proposed format combines existing weekly summaries.",
          custom_review_outcome: "",
        },
      },
    ],
  },
];

export function processTemplateDraft(
  currentSpec: ToolSpec,
  templateId: ProcessTemplateId,
): ToolSpec {
  const template = processTemplates.find(
    (candidate) => candidate.id === templateId,
  );
  if (!template) throw new Error("Choose a supported process template.");
  const next = structuredClone(template.spec);
  const existingCustom = currentSpec.fields.filter((field) =>
    field.id.startsWith("custom_"),
  );
  // Preserve existing descriptors as well as IDs: a template cannot shrink a
  // stored value, change its type, or hide a previously required field.
  next.fields = [
    ...next.fields.filter((field) => !field.id.startsWith("custom_")),
    ...structuredClone(existingCustom),
    ...next.fields.filter(
      (field) =>
        field.id.startsWith("custom_") &&
        !existingCustom.some((previous) => previous.id === field.id),
    ),
  ];
  const oldQueue = currentSpec.views.find((view) => view.id === "queue");
  const newQueue = next.views.find((view) => view.id === "queue");
  if (oldQueue && newQueue) {
    newQueue.columns = [
      ...new Set([
        ...newQueue.columns,
        ...oldQueue.columns.filter((column) => column.startsWith("custom_")),
      ]),
    ];
  }
  // Overflow is a visible validation failure, never a reason to drop fields.
  return toolSpecSchema.parse(next);
}
export const toolSpec = dataRequestTemplate;

export function toolCompatibility(
  before: ToolSpec,
  after: ToolSpec,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [],
    warnings: string[] = [];
  for (const previous of before.fields) {
    const next = after.fields.find((field) => field.id === previous.id);
    if (!next) {
      errors.push(
        `Field ${previous.label} (${previous.id}) cannot be removed or renamed while records may contain its data.`,
      );
      continue;
    }
    if (next.type !== previous.type)
      errors.push(`Field ${previous.id} cannot change type.`);
    if (next.maxLength < previous.maxLength)
      errors.push(
        `Field ${previous.id} cannot reduce its maximum length; existing data may exceed the new limit.`,
      );
    if (next.requiredAt === "intake" && previous.requiredAt !== "intake")
      errors.push(
        `Field ${previous.id} cannot become required at intake without a backfill strategy.`,
      );
    if (
      !next.visible &&
      (previous.requiredAt !== "optional" || next.requiredAt !== "optional")
    )
      errors.push(`Required field ${previous.id} cannot be hidden.`);
    if (next.requiredAt === "ready" && previous.requiredAt === "optional")
      warnings.push(
        `Existing requests may need ${next.label} before they can become ready.`,
      );
  }
  for (const field of after.fields) {
    if (before.fields.some((previous) => previous.id === field.id)) continue;
    if (field.requiredAt === "intake")
      errors.push(
        `New field ${field.id} cannot be required at intake without a backfill strategy.`,
      );
    if (field.requiredAt === "ready")
      warnings.push(
        `Existing requests may need ${field.label} before they can become ready.`,
      );
  }
  return { errors, warnings };
}
export function toolCompatibilityErrors(before: ToolSpec, after: ToolSpec) {
  return toolCompatibility(before, after).errors;
}
export function toolSpecChanges(before: ToolSpec, after: ToolSpec): string[] {
  const changes: string[] = [];
  if (before.title !== after.title)
    changes.push(`Title: “${before.title}” → “${after.title}”.`);
  if (before.description !== after.description)
    changes.push("Update the tool description.");
  for (const field of after.fields) {
    const previous = before.fields.find(
      (candidate) => candidate.id === field.id,
    );
    if (!previous) {
      changes.push(
        `Add ${field.label} (${field.id}), ${field.requiredAt === "optional" ? "optional" : `required at ${field.requiredAt}`}.`,
      );
      continue;
    }
    if (field.label !== previous.label)
      changes.push(
        `Rename label “${previous.label}” to “${field.label}” (${field.id}).`,
      );
    if (field.type !== previous.type)
      changes.push(
        `Change ${field.id} type: ${previous.type} → ${field.type}.`,
      );
    if (field.requiredAt !== previous.requiredAt)
      changes.push(
        `Change ${field.label} requirement: ${previous.requiredAt} → ${field.requiredAt}.`,
      );
    if (field.maxLength !== previous.maxLength)
      changes.push(
        `Change ${field.label} length limit: ${previous.maxLength} → ${field.maxLength}.`,
      );
    if (field.visible !== previous.visible)
      changes.push(`${field.visible ? "Show" : "Hide"} ${field.label}.`);
  }
  for (const field of before.fields)
    if (!after.fields.some((candidate) => candidate.id === field.id))
      changes.push(`Remove ${field.label} (${field.id}).`);
  if (
    JSON.stringify(before.fields.map((field) => field.id)) !==
      JSON.stringify(after.fields.map((field) => field.id)) &&
    before.fields.length === after.fields.length &&
    before.fields.every((field) =>
      after.fields.some((candidate) => candidate.id === field.id),
    )
  )
    changes.push("Reorder the form fields.");
  for (const view of after.views) {
    const previous = before.views.find((candidate) => candidate.id === view.id);
    if (JSON.stringify(previous) !== JSON.stringify(view))
      changes.push(`Update the ${view.id} view.`);
  }
  for (const action of after.actions)
    if (!before.actions.includes(action))
      changes.push(`Enable action ${action}.`);
  for (const action of before.actions)
    if (!after.actions.includes(action))
      changes.push(`Disable action ${action}.`);
  for (const [status, next] of Object.entries(after.statusLabels))
    if (
      before.statusLabels[status as keyof typeof before.statusLabels] !== next
    )
      changes.push(`Change ${status} label to “${next}”.`);
  return changes;
}
