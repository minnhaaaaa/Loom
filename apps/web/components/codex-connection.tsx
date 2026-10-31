"use client";

import { useEffect, useRef, useState } from "react";
import { workspaceFetch } from "./workspace-fetch";

type Connection = {
  configured: boolean;
  status:
    | "not_configured"
    | "not_connected"
    | "identity_verified"
    | "plan_enabled"
    | "reconnect_required";
  inferenceAvailable: boolean;
  canonicalOrigin: string | null;
  clientId: string | null;
  accounts: {
    clientId: string;
    email: string | null;
    name: string | null;
    active: boolean;
  }[];
  model: string | null;
  identity: {
    email: string | null;
    name: string | null;
    verifiedAt: string;
  } | null;
  message: string;
};

async function connectionRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await workspaceFetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(
      value?.error?.message || "The ChatGPT connection could not be updated.",
    );
  return value as T;
}

export function CodexConnection({
  preview,
  workspaceId,
}: {
  preview: boolean;
  workspaceId?: string;
}) {
  const [loaded, setLoaded] = useState<{
    workspaceId: string;
    connection: Connection;
  } | null>(null);
  const connection =
    loaded?.workspaceId === workspaceId ? loaded?.connection : null;
  const [model, setModel] = useState("");
  const [selectedClient, setSelectedClient] = useState("");
  const welcomeRef = useRef<HTMLDialogElement>(null);
  const welcomeKey = useRef("");
  const dismissed = useRef(new Set<string>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (preview || !workspaceId) return;
    const controller = new AbortController();
    void connectionRequest<Connection>("/api/workspaces/codex", {
      signal: controller.signal,
      headers: { "X-Loom-Workspace": workspaceId },
    })
      .then((result) => {
        if (!controller.signal.aborted) {
          setLoaded({ workspaceId: workspaceId || "", connection: result });
          setModel(result.model || "");
          setSelectedClient(
            result.clientId || result.accounts?.[0]?.clientId || "",
          );
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not load ChatGPT connection.",
          );
      });
    return () => controller.abort();
  }, [preview, workspaceId]);

  useEffect(() => {
    if (
      !workspaceId ||
      !connection?.clientId ||
      connection.status !== "plan_enabled"
    )
      return;
    const key = `loom-chatgpt-welcome:${workspaceId}:${connection.clientId}`;
    if (dismissed.current.has(key)) return;
    try {
      if (localStorage.getItem(key) === "seen") return;
    } catch {
      /* memory-only preference if storage is unavailable */
    }
    welcomeKey.current = key;
    if (!welcomeRef.current?.open) welcomeRef.current?.showModal();
  }, [workspaceId, connection]);
  function dismissWelcome() {
    if (welcomeKey.current) {
      dismissed.current.add(welcomeKey.current);
      try {
        localStorage.setItem(welcomeKey.current, "seen");
      } catch {
        /* no credentials are stored in this preference */
      }
    }
    welcomeRef.current?.close();
  }
  async function connect(newAccount = false) {
    setBusy(true);
    setError("");
    try {
      const result = await connectionRequest<{ authorizationUrl: string }>(
        "/api/workspaces/codex/start",
        {
          method: "POST",
          headers: { "X-Loom-Workspace": workspaceId || "" },
          body: JSON.stringify(
            newAccount
              ? { newAccount: true }
              : selectedClient
                ? { clientId: selectedClient }
                : {},
          ),
        },
      );
      const url = new URL(result.authorizationUrl);
      if (url.origin !== "https://auth.openai.com")
        throw new Error("Unexpected sign-in destination.");
      window.location.assign(url.href);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not start ChatGPT sign-in.",
      );
      setBusy(false);
    }
  }
  async function update(method: "PATCH" | "DELETE") {
    setBusy(true);
    setError("");
    try {
      const result = await connectionRequest<Connection>(
        "/api/workspaces/codex",
        {
          method,
          headers: { "X-Loom-Workspace": workspaceId || "" },
          body: JSON.stringify(
            method === "PATCH" ? { model: model.trim() } : {},
          ),
        },
      );
      setLoaded({ workspaceId: workspaceId || "", connection: result });
      setModel(result.model || "");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not update ChatGPT connection.",
      );
    } finally {
      setBusy(false);
    }
  }
  const wrongHost =
    connection?.canonicalOrigin &&
    typeof window !== "undefined" &&
    window.location.origin !== connection.canonicalOrigin;
  const statusMessage =
    connection?.message ?? (error ? "" : "Loading connection…");
  return (
    <div className="setup-agent-connect codex-connection" id="codex-connection">
      <h4>Use your ChatGPT account</h4>
      <p className="hint">
        Sign in with OpenAI to authorize your ChatGPT plan for this local Loom
        workspace. Your password stays with OpenAI.
      </p>
      {Boolean(connection?.accounts?.length) && (
        <label className="codex-account-picker">
          ChatGPT account
          <select
            value={selectedClient}
            disabled={busy}
            onChange={(event) => setSelectedClient(event.target.value)}
          >
            {connection?.accounts.map((account) => (
              <option key={account.clientId} value={account.clientId}>
                {account.email || account.name || "Saved registration"} ·{" "}
                {account.clientId.slice(-6)}
                {account.active ? " (active)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      {wrongHost ? (
        <a
          className="loom-text-link"
          href={`${connection.canonicalOrigin}/login`}
        >
          Sign in to Loom on 127.0.0.1
        </a>
      ) : (
        <button
          type="button"
          data-oai-siwc-button
          data-oai-siwc-button-client={selectedClient || undefined}
          disabled={preview || busy || !connection?.configured}
          onClick={() => void connect()}
        >
          {busy ? "Please wait…" : "Continue with ChatGPT"}
        </button>
      )}
      {Boolean(connection?.accounts?.length) && !wrongHost && (
        <button
          type="button"
          className="quiet"
          disabled={busy || preview || !connection?.configured}
          onClick={() => void connect(true)}
        >
          Use another ChatGPT account
        </button>
      )}
      {preview ? (
        <p className="hint">
          Live account connections are disabled in the test preview.
        </p>
      ) : statusMessage ? (
        <p className="hint" role="status">
          {statusMessage}
        </p>
      ) : null}
      {connection?.identity && (
        <p className="hint">
          {connection.identity.email ||
            connection.identity.name ||
            "ChatGPT account"}
        </p>
      )}
      {(connection?.status === "plan_enabled" ||
        connection?.inferenceAvailable) && (
        <div className="codex-model-settings">
          <label>
            ChatGPT model ID
            <input
              value={model}
              maxLength={200}
              onChange={(event) => setModel(event.target.value)}
              placeholder="Model ID available to your ChatGPT plan"
              disabled={busy}
            />
          </label>
          <button
            type="button"
            disabled={busy || !model.trim()}
            onClick={() => void update("PATCH")}
          >
            Save ChatGPT model
          </button>
          <p className="hint">
            Eligible requests use your ChatGPT plan. This authorization belongs
            to your account; it does not give colleagues access to your plan.
            Loom does not silently switch to API billing.
          </p>
          <a
            href="https://chatgpt.com/settings/usage"
            target="_blank"
            rel="noopener noreferrer"
          >
            Manage ChatGPT usage
          </a>
          <p className="hint">
            After choosing your model, select Save company setup to activate
            Codex as the preferred agent.
          </p>
        </div>
      )}
      {connection?.identity && (
        <button
          type="button"
          className="quiet"
          disabled={busy}
          onClick={() => void update("DELETE")}
        >
          Disconnect ChatGPT
        </button>
      )}
      <dialog
        ref={welcomeRef}
        className="codex-plan-welcome"
        aria-labelledby="codex-plan-welcome-title"
        onCancel={(event) => {
          event.preventDefault();
          dismissWelcome();
        }}
      >
        <h3 id="codex-plan-welcome-title">You’re using your ChatGPT plan</h3>
        <p>
          Eligible requests in Loom use your personal ChatGPT plan or available
          credits. This connection is for your own requests.
        </p>
        <p>
          <a
            href="https://chatgpt.com/settings/usage"
            target="_blank"
            rel="noopener noreferrer"
          >
            Manage usage in ChatGPT settings
          </a>
        </p>
        <button type="button" onClick={dismissWelcome}>
          Got it
        </button>
      </dialog>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
