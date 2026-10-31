import { z } from "zod";
import type { Actor, Role } from "./index";

export const invitationRoles = ["operator", "requester", "viewer"] as const;
export type InvitationRole = (typeof invitationRoles)[number];
const name = z.string().trim().min(1).max(100);
const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(12).max(128);
export const registerAccountSchema = z
  .object({
    name,
    email,
    password,
    workspaceName: z.string().trim().min(1).max(160),
  })
  .strict();
export const loginAccountSchema = z
  .object({ email, password: z.string().min(1).max(128) })
  .strict();
export const createWorkspaceSchema = z
  .object({ commandId: z.uuid(), name: z.string().trim().min(1).max(160) })
  .strict();
export const createInvitationSchema = z
  .object({ commandId: z.uuid(), role: z.enum(invitationRoles) })
  .strict();
export const acceptInvitationSchema = z
  .object({ name, email, password })
  .strict();
export const changeMembershipSchema = z
  .object({
    commandId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    role: z.enum(["owner", "operator", "requester", "viewer"]),
    active: z.boolean(),
  })
  .strict();
export const revokeInvitationSchema = z
  .object({ commandId: z.uuid(), expectedVersion: z.number().int().positive() })
  .strict();
export type RegistrationInput = z.infer<typeof registerAccountSchema>;
export type LoginInput = z.infer<typeof loginAccountSchema>;
export type InvitationCredentials = z.infer<typeof acceptInvitationSchema>;
export type SessionGrant = { token: string; actor: Actor };
export type WorkspaceSummary = { id: string; name: string; role: Role };
export type AccountContext = {
  user: { id: string; name: string; email: string | null } | null;
  workspaces: WorkspaceSummary[];
  currentWorkspaceId: string | null;
  authMode: "local-demo" | "workspace";
  registrationEnabled: boolean;
};
export type WorkspaceMember = {
  userId: string;
  name: string;
  role: Role;
  active: boolean;
  version: number;
};
export type WorkspaceInvitation = {
  id: string;
  role: InvitationRole;
  state: "pending" | "accepted" | "revoked";
  version: number;
  createdAt: string;
  expiresAt: string;
  createdBy: string;
};
export type WorkspaceAccess = {
  workspace: { id: string; name: string };
  membership: WorkspaceMember;
  members: WorkspaceMember[];
  invitations: WorkspaceInvitation[];
};
export type InvitationPreview = {
  workspace: { id: string; name: string };
  role: InvitationRole;
  expiresAt: string;
};
