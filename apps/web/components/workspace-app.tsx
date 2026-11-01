"use client";
import { useCallback, useEffect, useState } from "react";
import type { AccountContext, DeskSnapshot } from "@loom/contracts";
import { Desk } from "./desk";
import { AccountAccess, accessRequest } from "./account-access";
import { WorkspaceAccess } from "./workspace-access";

function scope(context: AccountContext) {
  const current = context.workspaces.find(
    (workspace) => workspace.id === context.currentWorkspaceId,
  );
  return `${context.user?.id || ""}/${current?.id || ""}/${current?.role || ""}`;
}
export function WorkspaceApp({
  initial,
  initialError,
  initialAccount,
  initialView,
}: {
  initial: DeskSnapshot;
  initialError: string | null;
  initialAccount: AccountContext;
  initialView?: "assistant" | "records" | "settings" | "insights" | "knowledge";
}) {
  const [account, setAccount] = useState(initialAccount);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    setLeaving(true);
    window.location.replace(`/app${window.location.search}`);
  }, []);
  useEffect(() => {
    if (initial.mode === "preview") return;
    const controller = new AbortController();
    let running = false;
    const refresh = async () => {
      if (running || document.visibilityState === "hidden") return;
      running = true;
      try {
        const next = await accessRequest<AccountContext>("/api/account", {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (scope(next) !== scope(initialAccount)) {
          await reload();
          return;
        }
        setAccount(next);
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (
          cause &&
          typeof cause === "object" &&
          "status" in cause &&
          [401, 403].includes(Number(cause.status))
        )
          await reload();
      } finally {
        running = false;
      }
    };
    const timer = setInterval(
      () => void refresh(),
      initial.refreshIntervalMs || 3000,
    );
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [initial.mode, initial.refreshIntervalMs, initialAccount, reload]);
  async function logout() {
    try {
      await accessRequest("/api/session", { method: "DELETE", body: "{}" });
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign out.");
    }
  }
  if (leaving)
    return (
      <p className="account-transition" role="status">
        Loading your workspace…
      </p>
    );
  if (account.user && !account.currentWorkspaceId)
    return (
      <main className="join-page">
        <h1>Your workspaces</h1>
        <WorkspaceAccess context={account} onChanged={reload} />
        <p>
          Choose an accessible workspace, create one, or open a new invitation
          from a colleague.
        </p>
        <button className="secondary" onClick={() => void logout()}>
          Sign out
        </button>
        {error && <p role="alert">{error}</p>}
      </main>
    );
  return (
    <Desk
      key={`${scope(account)}/${initialView || "default"}`}
      initial={initial}
      initialError={initialError}
      initialView={initialView}
      setupInitiallyOpen={Boolean(account.user?.email)}
      onSessionChanged={reload}
      showDemoControls={
        account.authMode === "local-demo" && !account.user?.email
      }
      workspaceControls={
        initial.mode === "preview" ? undefined : (
          <>
            {account.user ? (
              <>
                <WorkspaceAccess
                  key={`${account.user.id}/${account.currentWorkspaceId}`}
                  context={account}
                  onChanged={reload}
                />
                {account.user.email && (
                  <button className="quiet" onClick={() => void logout()}>
                    Sign out
                  </button>
                )}
              </>
            ) : (
              <AccountAccess
                onAuthenticated={reload}
                registrationEnabled={account.registrationEnabled}
              />
            )}
            {error && (
              <p role="alert" className="alert">
                {error}
              </p>
            )}
          </>
        )
      }
    />
  );
}
