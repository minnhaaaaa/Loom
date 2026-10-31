"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import Link from "next/link";
import type { AccountContext, InvitationPreview } from "@loom/contracts";
import { accessRequest } from "./account-access";

export function InvitationAccept({
  onAuthenticated,
}: {
  onAuthenticated?: () => Promise<void>;
}) {
  const id = useId();
  const [token, setToken] = useState("");
  const [account, setAccount] = useState<AccountContext | null>(null);
  const [invitation, setInvitation] = useState<InvitationPreview | null>(null);
  const [mode, setMode] = useState<"create" | "login">("create");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const invitationToken = new URLSearchParams(
        window.location.hash.slice(1),
      ).get("token");
      if (!invitationToken)
        throw new Error(
          "This invitation link is incomplete. Open the full link your workspace owner shared.",
        );
      const [nextAccount, preview] = await Promise.all([
        accessRequest<AccountContext>("/api/account", {
          signal: controller.signal,
        }),
        accessRequest<InvitationPreview>("/api/invitations/preview", {
          method: "POST",
          body: JSON.stringify({ token: invitationToken }),
          signal: controller.signal,
        }),
      ]);
      if (controller.signal.aborted) return;
      setToken(invitationToken);
      setAccount(nextAccount);
      setInvitation(preview);
    })()
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  async function join(event: FormEvent) {
    event.preventDefault();
    if (!token || !invitation || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      let signedIn = Boolean(account?.user);
      if (!signedIn && mode === "login") {
        await accessRequest("/api/account/login", {
          method: "POST",
          body: JSON.stringify({ email, password }),
        });
        setAccount(await accessRequest<AccountContext>("/api/account"));
        signedIn = true;
      }
      await accessRequest("/api/invitations/accept", {
        method: "POST",
        body: JSON.stringify(
          signedIn ? { token } : { token, name, email, password },
        ),
      });
      setPassword("");
      setNotice("Invitation accepted. Opening your workspace…");
      window.history.replaceState(null, "", window.location.pathname);
      if (onAuthenticated) await onAuthenticated();
      else window.location.assign(new URL("/", window.location.origin).href);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The invitation could not be accepted.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function differentAccount() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await accessRequest("/api/session", { method: "DELETE", body: "{}" });
      setAccount(await accessRequest<AccountContext>("/api/account"));
      setMode("login");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not change accounts.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="invitation-accept">
      <Link className="brand" href="/" aria-label="Loom home">
        <span className="brand-mark" aria-hidden="true">
          L
        </span>
        Loom
      </Link>
      <section
        className="invitation-accept-card"
        aria-label="Workspace invitation"
      >
        <div className="invitation-accept-intro">
          <p className="eyebrow">A place on the team</p>
          <h1>
            {invitation
              ? `Join ${invitation.workspace.name}`
              : loading
                ? "Opening your invitation…"
                : "Invitation unavailable"}
          </h1>
          {invitation && (
            <>
              <p>
                You’ve been invited as a <strong>{invitation.role}</strong>.
              </p>
              <small>
                Invitation expires{" "}
                {new Date(invitation.expiresAt).toLocaleString("en-IN")}.
              </small>
            </>
          )}
        </div>
        {loading && <p role="status">Checking invitation and account…</p>}
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        {invitation && (
          <form onSubmit={(event) => void join(event)}>
            {account?.user ? (
              <div className="invitation-accept-person">
                <span>Continue as</span>
                <strong>{account.user.name}</strong>
                {account.user.email && <small>{account.user.email}</small>}
                <button
                  className="quiet"
                  type="button"
                  disabled={busy}
                  onClick={() => void differentAccount()}
                >
                  Use a different account
                </button>
              </div>
            ) : (
              <>
                <div
                  className="account-access-tabs"
                  role="tablist"
                  aria-label="Join account options"
                >
                  <button
                    type="button"
                    role="tab"
                    id={`${id}-create`}
                    aria-controls={`${id}-join-panel`}
                    aria-selected={mode === "create"}
                    disabled={busy}
                    onClick={() => {
                      setMode("create");
                      setError("");
                    }}
                  >
                    Create an account
                  </button>
                  <button
                    type="button"
                    role="tab"
                    id={`${id}-login`}
                    aria-controls={`${id}-join-panel`}
                    aria-selected={mode === "login"}
                    disabled={busy}
                    onClick={() => {
                      setMode("login");
                      setError("");
                    }}
                  >
                    Use an existing account
                  </button>
                </div>
                <div
                  role="tabpanel"
                  id={`${id}-join-panel`}
                  aria-labelledby={`${id}-${mode}`}
                >
                  {mode === "create" && (
                    <label>
                      Your name
                      <input
                        autoComplete="name"
                        maxLength={100}
                        required
                        value={name}
                        disabled={busy}
                        onChange={(event) => setName(event.target.value)}
                      />
                    </label>
                  )}
                  <label>
                    Email address
                    <input
                      type="email"
                      autoComplete="email"
                      maxLength={254}
                      required
                      value={email}
                      disabled={busy}
                      onChange={(event) => setEmail(event.target.value)}
                    />
                  </label>
                  <label>
                    Password
                    <input
                      type="password"
                      autoComplete={
                        mode === "create" ? "new-password" : "current-password"
                      }
                      minLength={mode === "create" ? 12 : 1}
                      maxLength={128}
                      required
                      value={password}
                      disabled={busy}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </label>
                  {mode === "create" && (
                    <p className="hint">
                      Choose a password with at least 12 characters. Your
                      account can belong to more than one workspace.
                    </p>
                  )}
                </div>
              </>
            )}
            <button
              className="invitation-accept-submit"
              disabled={busy || !token}
              type="submit"
            >
              {busy
                ? "Joining workspace…"
                : account?.user
                  ? "Join workspace"
                  : mode === "login"
                    ? "Sign in and join workspace"
                    : "Create account and join workspace"}
            </button>
          </form>
        )}
        <p className="notice" role="status" aria-live="polite">
          {notice}
        </p>
        {!loading && !invitation && (
          <p className="hint">
            Ask your workspace owner for a new link if this invitation has
            expired or been revoked.
          </p>
        )}
      </section>
    </main>
  );
}
