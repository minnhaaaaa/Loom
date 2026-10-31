"use client";
import { workspaceFetch } from "./workspace-fetch";

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
  const response = await workspaceFetch(path, {
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
  initialMode = "login",
}: {
  onAuthenticated: () => Promise<void>;
  initialMode?: "login" | "register";
}) {
  const id = useId();
  const [context, setContext] = useState<AccountContext | null>(null);
  const [mode, setMode] = useState<"login" | "register">(initialMode);
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
        mode === "register" ? "Your company workspace is ready." : "Signed in.",
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
          <p className="eyebrow">Your analytics team, connected</p>
          <h2>
            {mode === "register"
              ? "Give your data requests a home."
              : "Welcome back to your company."}
          </h2>
          <p>
            {mode === "register"
              ? "Create your company’s analytics workspace, then invite your analysts and colleagues."
              : "Use your own work account. Your company memberships determine the requests and knowledge you can access."}
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
              Create a company
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
                Company name
                <input
                  maxLength={160}
                  required
                  disabled={busy}
                  value={workspaceName}
                  onChange={(event) => setWorkspaceName(event.target.value)}
                  autoComplete="organization"
                  placeholder="Your company"
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
              Use at least 12 characters. You’ll be the company admin and can
              invite analysts and requesters after registration.
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
                ? "Create company and account"
                : "Sign in to company"}
          </button>
          {context && !context.registrationEnabled && (
            <p className="hint">
              {mode === "register"
                ? "New company registration is not enabled on this deployment. Existing staff can sign in or use an invitation from their company admin."
                : "Joining a company? Open the invitation link your company admin shared."}
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
