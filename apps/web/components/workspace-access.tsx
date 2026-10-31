"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  roles,
  invitationRoles,
  type AccountContext,
  type InvitationRole,
  type Role,
  type WorkspaceAccess as WorkspaceAccessState,
  type WorkspaceInvitation,
  type WorkspaceMember,
} from "@loom/contracts";
import { AccessError, accessRequest } from "./account-access";

const timestamp = (value: string) => new Date(value).toLocaleString("en-IN");

export function WorkspaceAccess({
  context,
  onChanged,
}: {
  context: AccountContext;
  onChanged: () => Promise<void>;
}) {
  const current = context.workspaces.find(
    (workspace) => workspace.id === context.currentWorkspaceId,
  );
  const owner = current?.role === "owner";
  const userId = context.user?.id;
  const [access, setAccess] = useState<WorkspaceAccessState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [invitationRole, setInvitationRole] =
    useState<InvitationRole>("requester");
  const [invitationLink, setInvitationLink] = useState<{
    id: string;
    url: string;
  } | null>(null);
  const [roleEdits, setRoleEdits] = useState<
    Record<string, { role: Role; expectedVersion: number }>
  >({});
  const pending = useRef<{ payload: string; id: string } | null>(null);
  const accessFetch = useRef<AbortController | null>(null);
  const accessGeneration = useRef(0);
  const activeOwners =
    access?.members.filter((member) => member.active && member.role === "owner")
      .length ?? 0;

  const cancelAccessFetch = useCallback(() => {
    ++accessGeneration.current;
    accessFetch.current?.abort();
  }, []);

  const clearAccess = useCallback(() => {
    cancelAccessFetch();
    setAccess(null);
    setInvitationLink(null);
    setRoleEdits({});
  }, [cancelAccessFetch]);

  const refreshAccess = useCallback(async () => {
    if (accessFetch.current) return;
    const controller = new AbortController();
    accessFetch.current = controller;
    const generation = ++accessGeneration.current;
    try {
      const next = await accessRequest<WorkspaceAccessState>(
        "/api/workspaces/access",
        { signal: controller.signal },
      );
      if (!controller.signal.aborted && generation === accessGeneration.current)
        setAccess(next);
    } catch (reason) {
      if (reason instanceof AccessError && [401, 403].includes(reason.status))
        clearAccess();
      throw reason;
    } finally {
      if (accessFetch.current === controller) accessFetch.current = null;
    }
  }, [clearAccess]);

  useEffect(() => {
    if (!userId || !owner || !context.currentWorkspaceId) return;
    let active = true;
    const refresh = () => {
      void refreshAccess().catch((reason) => {
        if (active && reason.name !== "AbortError") setError(reason.message);
      });
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      cancelAccessFetch();
    };
  }, [
    userId,
    context.currentWorkspaceId,
    owner,
    refreshAccess,
    cancelAccessFetch,
  ]);

  async function command<T>(path: string, values: object): Promise<T> {
    const payload = JSON.stringify({ path, values });
    if (pending.current?.payload !== payload)
      pending.current = { payload, id: crypto.randomUUID() };
    const result = await accessRequest<T>(path, {
      method: "POST",
      body: JSON.stringify({ ...values, commandId: pending.current.id }),
    });
    pending.current = null;
    return result;
  }

  async function work(task: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await task();
    } catch (reason) {
      if (reason instanceof AccessError && [401, 403].includes(reason.status))
        clearAccess();
      setError(
        reason instanceof Error
          ? reason.message
          : "Workspace access could not be updated.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function selectWorkspace(workspaceId: string) {
    if (workspaceId === context.currentWorkspaceId) return;
    await work(async () => {
      await accessRequest("/api/workspaces/select", {
        method: "POST",
        body: JSON.stringify({ workspaceId }),
      });
      setAccess(null);
      setInvitationLink(null);
      await onChanged();
    });
  }

  async function createWorkspace(event: FormEvent) {
    event.preventDefault();
    await work(async () => {
      await command("/api/workspaces", { name: workspaceName });
      setWorkspaceName("");
      setAccess(null);
      setInvitationLink(null);
      await onChanged();
    });
  }

  async function invite(event: FormEvent) {
    event.preventDefault();
    await work(async () => {
      const invitation = await command<WorkspaceInvitation & { token: string }>(
        "/api/workspaces/invitations",
        { role: invitationRole },
      );
      const url = new URL("/join", window.location.origin);
      url.hash = new URLSearchParams({ token: invitation.token }).toString();
      setInvitationLink({ id: invitation.id, url: url.toString() });
      await refreshAccess();
      setMessage(
        "Invitation created. Copy the link now and share it with your colleague.",
      );
    });
  }

  async function updateMember(
    member: WorkspaceMember,
    role: Role,
    active: boolean,
    expectedVersion = member.version,
  ) {
    await work(async () => {
      await command(`/api/workspaces/members/${member.userId}`, {
        expectedVersion,
        role,
        active,
      });
      setRoleEdits((previous) => {
        const next = { ...previous };
        delete next[member.userId];
        return next;
      });
      await refreshAccess();
      setMessage(
        active ? "Workspace access updated." : "Workspace access removed.",
      );
      await onChanged();
    });
  }

  async function revoke(invitation: WorkspaceInvitation) {
    await work(async () => {
      await command(`/api/workspaces/invitations/${invitation.id}/revoke`, {
        expectedVersion: invitation.version,
      });
      if (invitationLink?.id === invitation.id) setInvitationLink(null);
      await refreshAccess();
      setMessage("Invitation revoked. Its link can no longer be used.");
    });
  }

  async function copyInvitation() {
    if (!invitationLink) return;
    try {
      await navigator.clipboard.writeText(invitationLink.url);
      setMessage("Invitation link copied.");
    } catch {
      setMessage("Select and copy the invitation link above.");
    }
  }

  if (!context.user) return null;

  return (
    <section className="workspace-access" aria-label="Workspace access">
      <div className="workspace-access-bar">
        <label>
          Current workspace
          <select
            aria-label="Current workspace"
            value={context.currentWorkspaceId || ""}
            disabled={busy || !context.workspaces.length}
            onChange={(event) => void selectWorkspace(event.target.value)}
          >
            <option value="" disabled>
              Choose workspace
            </option>
            {context.workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name} · {workspace.role}
              </option>
            ))}
          </select>
        </label>
        <span className="workspace-access-identity">
          <strong>{context.user.name}</strong>
          <small>{context.user.email || "Local demonstration identity"}</small>
        </span>
        <details className="workspace-access-create">
          <summary>New workspace</summary>
          <form onSubmit={(event) => void createWorkspace(event)}>
            <label>
              New workspace name
              <input
                required
                maxLength={160}
                value={workspaceName}
                disabled={busy}
                onChange={(event) => setWorkspaceName(event.target.value)}
              />
            </label>
            <button disabled={busy || !workspaceName.trim()} type="submit">
              Create workspace
            </button>
          </form>
        </details>
      </div>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <p className="notice" role="status" aria-live="polite">
        {busy ? "Updating workspace…" : message}
      </p>
      {!context.workspaces.length && (
        <p className="hint">
          You don’t currently have access to a workspace. Create one or open an
          invitation from a colleague.
        </p>
      )}

      {owner && (
        <details className="workspace-access-share">
          <summary>
            <strong>Share workspace</strong>
            <span>People, roles, and invitation links</span>
          </summary>
          <div className="workspace-access-share-body">
            <div className="workspace-access-heading">
              <div>
                <p className="eyebrow">Work together</p>
                <h2>Invite a colleague into {current.name}.</h2>
                <p>
                  Each person uses their own account. Choose what they can see
                  and change.
                </p>
              </div>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void work(refreshAccess)}
              >
                Refresh access
              </button>
            </div>
            <div className="workspace-access-invite">
              <form onSubmit={(event) => void invite(event)}>
                <label>
                  Invitation role
                  <select
                    value={invitationRole}
                    disabled={busy}
                    onChange={(event) =>
                      setInvitationRole(event.target.value as InvitationRole)
                    }
                  >
                    {invitationRoles.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" disabled={busy}>
                  Create invitation link
                </button>
              </form>
              <p>
                Operators manage the queue. Requesters see their own requests.
                Viewers can read the team queue. Links expire after 24 hours and
                can be accepted once.
              </p>
              {invitationLink && (
                <div className="workspace-access-copy">
                  <label>
                    Invitation link
                    <input
                      readOnly
                      value={invitationLink.url}
                      onFocus={(event) => event.target.select()}
                    />
                  </label>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => void copyInvitation()}
                  >
                    Copy invitation link
                  </button>
                  <small>
                    Copy this link before leaving this page. Saved invitation
                    history doesn’t reveal the link again.
                  </small>
                </div>
              )}
            </div>
            <section aria-label="Workspace members">
              <h3>People with access</h3>
              <p className="hint">
                Keep at least one active owner. Role changes apply to the next
                authorized refresh.
              </p>
              {!access && <p role="status">Loading workspace members…</p>}
              <div className="workspace-access-members">
                {access?.members.map((member) => {
                  const lastOwner =
                    member.active &&
                    member.role === "owner" &&
                    activeOwners <= 1;
                  const roleEdit = roleEdits[member.userId];
                  const nextRole = roleEdit?.role ?? member.role;
                  const staleRole = Boolean(
                    roleEdit && roleEdit.expectedVersion !== member.version,
                  );
                  return (
                    <article
                      key={member.userId}
                      className={
                        member.active ? "" : "workspace-access-inactive"
                      }
                      aria-label={`Access for ${member.name}`}
                    >
                      <div>
                        <strong>
                          {member.name}
                          {member.userId === context.user?.id ? " (you)" : ""}
                        </strong>
                        <small>
                          {member.active
                            ? `Current role: ${member.role}`
                            : "Access removed"}
                          {lastOwner ? " · Last active owner" : ""}
                        </small>
                      </div>
                      <label>
                        Role
                        <select
                          aria-label={`Role for ${member.name}`}
                          value={nextRole}
                          disabled={busy || !member.active}
                          onChange={(event) =>
                            setRoleEdits({
                              ...roleEdits,
                              [member.userId]: {
                                role: event.target.value as Role,
                                expectedVersion: member.version,
                              },
                            })
                          }
                        >
                          {roles.map((role) => (
                            <option key={role} value={role}>
                              {role}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        className="secondary"
                        aria-label={`Save role for ${member.name}`}
                        disabled={
                          busy ||
                          !member.active ||
                          nextRole === member.role ||
                          staleRole ||
                          (lastOwner && nextRole !== "owner")
                        }
                        onClick={() =>
                          void updateMember(
                            member,
                            nextRole,
                            member.active,
                            roleEdit?.expectedVersion ?? member.version,
                          )
                        }
                      >
                        Save role
                      </button>
                      {staleRole && (
                        <button
                          className="quiet"
                          disabled={busy}
                          onClick={() => {
                            setRoleEdits({
                              ...roleEdits,
                              [member.userId]: {
                                role: nextRole,
                                expectedVersion: member.version,
                              },
                            });
                            setMessage(
                              `Review ${member.name}’s current role (${member.role}) and your selected role before saving.`,
                            );
                          }}
                        >
                          Use current access version
                        </button>
                      )}
                      {member.active ? (
                        <button
                          className="quiet"
                          aria-label={`Remove access for ${member.name}`}
                          disabled={busy || lastOwner}
                          onClick={() =>
                            void updateMember(member, member.role, false)
                          }
                        >
                          Remove access
                        </button>
                      ) : (
                        <button
                          className="secondary"
                          aria-label={`Restore access for ${member.name}`}
                          disabled={busy}
                          onClick={() =>
                            void updateMember(member, member.role, true)
                          }
                        >
                          Restore access
                        </button>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>
            <section
              className="workspace-access-invitations"
              aria-label="Workspace invitations"
            >
              <h3>Invitation history</h3>
              {access && !access.invitations.length && (
                <p className="muted">
                  Create an invitation link to bring in your first colleague.
                </p>
              )}
              {access?.invitations.map((invitation) => (
                <article
                  key={invitation.id}
                  aria-label={`Invitation ${invitation.id}`}
                >
                  <div>
                    <strong>{invitation.role} invitation</strong>
                    <small>
                      {invitation.state} · expires{" "}
                      {timestamp(invitation.expiresAt)}
                    </small>
                  </div>
                  {invitation.state === "pending" && (
                    <button
                      className="secondary"
                      disabled={busy}
                      aria-label={`Revoke invitation ${invitation.id}`}
                      onClick={() => void revoke(invitation)}
                    >
                      Revoke link
                    </button>
                  )}
                </article>
              ))}
            </section>
          </div>
        </details>
      )}
    </section>
  );
}
