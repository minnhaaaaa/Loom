import { z } from "zod";

const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color, such as #19161e.")
  .transform((value) => value.toLowerCase());
export const workspaceBrandingSchema = z
  .object({
    companyName: z.string().trim().max(100),
    logoDataUrl: z
      .string()
      .max(180_000)
      .regex(
        /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/,
        "Choose a PNG, JPEG, or WebP logo.",
      )
      .nullable(),
    primaryColor: color,
    accentColor: color,
    font: z.enum(["modern", "classic", "technical"]),
    corners: z.enum(["rounded", "square"]),
  })
  .strict();
export type WorkspaceBranding = z.infer<typeof workspaceBrandingSchema>;
export const preferredAgents = [
  "loom",
  "codex",
  "claude-code",
  "other",
  "later",
] as const;
export type PreferredAgent = (typeof preferredAgents)[number];
export const workspaceSettingsSchema = z
  .object({
    version: z.number().int().nonnegative(),
    branding: workspaceBrandingSchema,
    preferredAgent: z.enum(preferredAgents),
    setupCompletedAt: z.iso.datetime().nullable(),
    updatedAt: z.iso.datetime().nullable(),
  })
  .strict();
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;
export const defaultWorkspaceSettings: WorkspaceSettings = {
  version: 0,
  branding: {
    companyName: "",
    logoDataUrl: null,
    primaryColor: "#19161e",
    accentColor: "#e1bdff",
    font: "modern",
    corners: "rounded",
  },
  preferredAgent: "later",
  setupCompletedAt: null,
  updatedAt: null,
};
export const updateWorkspaceSettingsSchema = z
  .object({
    commandId: z.uuid(),
    expectedVersion: z.number().int().nonnegative(),
    branding: workspaceBrandingSchema,
    preferredAgent: z.enum(preferredAgents),
    completeSetup: z.boolean(),
  })
  .strict()
  .superRefine((values, context) => {
    if (values.completeSetup && !values.branding.companyName)
      context.addIssue({
        code: "custom",
        path: ["branding", "companyName"],
        message: "Add your company name before finishing setup.",
      });
  });
export type UpdateWorkspaceSettings = z.infer<
  typeof updateWorkspaceSettingsSchema
>;
export const agentClients = ["codex", "claude-code", "other"] as const;
export type AgentClient = (typeof agentClients)[number];
export const createAgentConnectionSchema = z
  .object({
    commandId: z.uuid(),
    label: z.string().trim().min(1).max(100),
    client: z.enum(agentClients),
  })
  .strict();
export const revokeAgentConnectionSchema = z
  .object({
    commandId: z.uuid(),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export type CreateAgentConnection = z.infer<typeof createAgentConnectionSchema>;
export type AgentConnection = {
  id: string;
  version: number;
  label: string;
  client: AgentClient;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  clientName: string | null;
  tokenPrefix: string;
};
export type CreatedAgentConnection = {
  connection: AgentConnection;
  token: string | null;
};
