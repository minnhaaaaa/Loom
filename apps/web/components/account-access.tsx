"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import type { AccountContext } from "@loom/contracts";

export class AccessError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
  ) {
    super(message);
  }
}

export async function accessRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const body = await response.json();
  if (!response.ok)
    throw new AccessError(
      body.error?.message || "The change could not be confirmed. Try again.",
      response.status,
      body.error?.code || "UNKNOWN",
    );
  return body as T;
}

export function AccountAccess({
  onAuthenticated,
}: {
  onAuthenticated: () => Promise<void>;
}) {
  const id = useId();
  const [context, setContext] = useState<AccountContext | null>(null);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void accessRequest<AccountContext>("/api/account", {
      signal: controller.signal,
    })
      .then((next) => {
        if (!controller.signal.aborted) setContext(next);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason.message);
      });
    return () => controller.abort();
  }, []);

  async function authenticate(event: FormEvent) {
    event.preventDefault();
    if (busy || (mode === "register" && !context?.registrationEnabled)) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await accessRequest(
        mode === "register" ? "/api/account/register" : "/api/account/login",
        {
          method: "POST",
          body: JSON.stringify(
            mode === "register"
              ? { name, email, password, workspaceName }
              : { email, password },
          ),
        },
      );
      setPassword("");
      setNotice(
        mode === "register" ? "Your workspace is ready." : "Signed in.",
      );
      await onAuthenticated();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The account could not be opened.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="account-access" aria-label="Account access">
      <div className="account-access-intro">
        <span className="brand-mark" aria-hidden="true">
          L
        </span>
        <div>
          <p className="eyebrow">Your team’s workspace</p>
          <h2>
            {mode === "register"
              ? "Give the work a home."
              : "Pick up where your team left off."}
          </h2>
          <p>
            Use your own account to share requests, review changes, and keep the
            team’s work together.
          </p>
        </div>
      </div>
      <div className="account-access-form">
        <div
          className="account-access-tabs"
          role="tablist"
          aria-label="Account options"
        >
          <button
            type="button"
            role="tab"
            id={`${id}-login`}
            aria-controls={`${id}-panel`}
            aria-selected={mode === "login"}
            disabled={busy}
            onClick={() => {
              setMode("login");
              setError("");
            }}
          >
            Sign in
          </button>
          {context?.registrationEnabled && (
            <button
              type="button"
              role="tab"
              id={`${id}-register`}
              aria-controls={`${id}-panel`}
              aria-selected={mode === "register"}
              disabled={busy}
              onClick={() => {
                setMode("register");
                setError("");
              }}
            >
              Create a workspace
            </button>
          )}
        </div>
        <form
          onSubmit={(event) => void authenticate(event)}
          role="tabpanel"
          id={`${id}-panel`}
          aria-labelledby={`${id}-${mode}`}
        >
          {mode === "register" && (
            <>
              <label>
                Your name
                <input
                  autoComplete="name"
                  maxLength={100}
                  required
                  disabled={busy}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                Workspace name
                <input
                  maxLength={160}
                  required
                  disabled={busy}
                  value={workspaceName}
                  onChange={(event) => setWorkspaceName(event.target.value)}
                  placeholder="Analytics team"
                />
              </label>
            </>
          )}
          <label>
            Email address
            <input
              type="email"
              autoComplete="email"
              maxLength={254}
              required
              disabled={busy}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete={
                mode === "register" ? "new-password" : "current-password"
              }
              minLength={mode === "register" ? 12 : 1}
              maxLength={128}
              required
              disabled={busy}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {mode === "register" && (
            <p className="hint">
              Use at least 12 characters. You’ll be the first owner and can
              invite colleagues after creating the workspace.
            </p>
          )}
          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
          <p className="notice" role="status" aria-live="polite">
            {notice}
          </p>
          <button
            disabled={
              busy ||
              !context ||
              (mode === "register" && !context.registrationEnabled)
            }
            type="submit"
          >
            {busy
              ? "Opening workspace…"
              : mode === "register"
                ? "Create workspace and account"
                : "Sign in to workspace"}
          </button>
          {context && !context.registrationEnabled && (
            <p className="hint">
              Joining a new team? Open the invitation link your workspace owner
              shared.
            </p>
          )}
          {!context && !error && (
            <p className="hint" role="status">
              Checking account access…
            </p>
          )}
        </form>
      </div>
    </section>
  );
}
