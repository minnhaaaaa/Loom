import { z } from "zod";
import { commandSchema } from "./index";
import { toolSpecSchema } from "./tools";

// Stable IDs and snapshot digests bind external work to the exact authorized
// context. Connecting a client never grants business-write or approval tools.
export const externalProposalSchema = z
  .object({
    commandId: z.uuid(),
    taskId: z.uuid().optional(),
    requestId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    toolRevision: z.number().int().positive(),
    knowledgeDigest: z.string().regex(/^[a-f0-9]{64}$/),
    summary: z.string().trim().min(1).max(2000),
    reasons: z.array(z.string().trim().min(1).max(1000)).min(1).max(8),
    uncertainty: z.array(z.string().trim().min(1).max(1000)).max(8),
    evidenceIds: z.array(z.uuid()).max(50),
    commands: z
      .array(z.lazy(() => commandSchema))
      .min(1)
      .max(6),
  })
  .strict();
export type ExternalProposalInput = z.infer<typeof externalProposalSchema>;

export const externalTaskReplySchema = z
  .object({
    commandId: z.uuid(),
    taskId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    contextHash: z.string().regex(/^[a-f0-9]{64}$/),
    reply: z.string().trim().min(1).max(8000),
    evidenceIds: z.array(z.uuid()).max(20),
    proposalIds: z.array(z.uuid()).max(6),
  })
  .strict()
  .superRefine((value, context) => {
    for (const key of ["evidenceIds", "proposalIds"] as const) {
      if (new Set(value[key]).size !== value[key].length)
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Use unique saved IDs.",
        });
    }
  });
export type ExternalTaskReplyInput = z.infer<typeof externalTaskReplySchema>;

export const externalToolDraftSchema = z
  .object({
    commandId: z.uuid(),
    taskId: z.uuid(),
    expectedTaskVersion: z.number().int().positive(),
    contextHash: z.string().regex(/^[a-f0-9]{64}$/),
    expectedRevision: z.number().int().positive(),
    spec: toolSpecSchema,
  })
  .strict();
export type ExternalToolDraftInput = z.infer<typeof externalToolDraftSchema>;
