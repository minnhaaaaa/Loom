"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { AccountContext } from "@loom/contracts";
import { AccountAccess, accessRequest } from "./account-access";

export function WorkspaceLink({ workspaceId }: { workspaceId: string }) {
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState("");
  const open = useCallback(
    async (signal?: AbortSignal) => {
      const context = await accessRequest<AccountContext>("/api/account", {
        signal,
      });
      if (!context.user) {
        return false;
      }
      await accessRequest("/api/workspaces/select", {
        method: "POST",
        body: JSON.stringify({ workspaceId }),
        signal,
      });
      if (!signal?.aborted) window.location.replace("/");
      return true;
    },
    [workspaceId],
  );
  useEffect(() => {
    const controller = new AbortController();
    void open(controller.signal)
      .then((opened) => {
        if (!controller.signal.aborted && !opened) setSignedOut(true);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => {
      controller.abort();
    };
  }, [open]);
  return (
    <main className="join-page">
      <h1>Open a shared workspace</h1>
      <p>
        Sign in with an account that has access. An invitation from an owner is
        required to join a new workspace.
      </p>
      {signedOut && (
        <AccountAccess
          onAuthenticated={async () => {
            await open();
          }}
        />
      )}
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : (
        !signedOut && <p role="status">Opening your workspace…</p>
      )}
      <Link href="/">Open your workspaces</Link>
    </main>
  );
}
