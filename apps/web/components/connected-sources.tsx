"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { SourceProvider, SourceSnapshot } from "@loom/contracts";
import { accessRequest } from "./account-access";
import { LoomSelect } from "./ui/loom-select";
import {
  SourceConnectionWizard,
  sourceLabels as labels,
  connectionKind,
} from "./source-connection-wizard";
export function ConnectedSources({ workspaceId }: { workspaceId: string }) {
  return <SourceSettings key={workspaceId} workspaceId={workspaceId} />;
}
function SourceSettings({ workspaceId }: { workspaceId: string }) {
  const id = useId(),
    alive = useRef(true),
    pending = useRef(false);
  const [snapshot, setSnapshot] = useState<SourceSnapshot | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const [wizard, setWizard] = useState<SourceProvider | null>(null);
  const call = useCallback(
    <T,>(body?: unknown, signal?: AbortSignal) =>
      accessRequest<T>("/api/workspaces/sources", {
        ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
        headers: { "X-Loom-Workspace": workspaceId },
        signal,
      }),
    [workspaceId],
  );
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    const refresh = () => {
      void call<SourceSnapshot>(undefined, controller.signal)
        .then((value) => {
          if (alive.current) setSnapshot(value);
        })
        .catch((cause) => {
          if (!controller.signal.aborted && alive.current)
            setError(
              cause instanceof Error
                ? cause.message
                : "Could not load connected sources.",
            );
        });
    };
    refresh();
    const timer = setInterval(refresh, 15_000);
    return () => {
      alive.current = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [call]);
  async function act(task: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "This action could not finish.",
        );
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section
      className="connected-sources"
      id="connected-sources"
      aria-labelledby={`${id}-heading`}
    >
      <h2 id={`${id}-heading`}>Connected sources</h2>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {!snapshot && !error && <p role="status">Loading connections…</p>}
      {snapshot && (
        <>
          <div className="source-service-grid">
            {(
              [
                "github",
                "slack",
                "teams",
                "sharepoint",
                "discord",
              ] as SourceProvider[]
            ).map((provider) => {
              const connection = snapshot.connections.find(
                (item) => item.provider === connectionKind(provider),
              );
              return (
                <button
                  key={provider}
                  disabled={busy}
                  className="source-service"
                  onClick={() => setWizard(provider)}
                  aria-label={`${connection ? "Manage" : "Connect"} ${labels[provider]}`}
                >
                  <strong>{labels[provider]}</strong>
                  <span>{connection ? "Connected · Manage" : "Connect"}</span>
                </button>
              );
            })}
          </div>
          {wizard && (
            <SourceConnectionWizard
              key={wizard}
              provider={wizard}
              workspaceId={workspaceId}
              snapshot={snapshot}
              onSnapshot={setSnapshot}
              onClose={() => setWizard(null)}
            />
          )}
          {!snapshot.syncEnabled && (
            <p role="status">
              Automatic sync is disabled on this server. Enable LOOM_SOURCE_SYNC
              to start imports.
            </p>
          )}
          {snapshot.sources.length > 0 && (
            <ul className="source-list">
              {snapshot.sources.map((source) => (
                <li key={source.id}>
                  <div>
                    <strong>{source.name}</strong>
                    <span>
                      {labels[source.provider]} · {source.imported} imported
                      {source.skipped
                        ? ` · ${source.skipped} files not imported`
                        : ""}
                    </span>
                    <span>
                      {!source.active
                        ? "Paused"
                        : source.syncing
                          ? "Syncing…"
                          : source.lastSyncedAt
                            ? `Last sync ${new Date(source.lastSyncedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                            : "Waiting for first sync"}
                    </span>
                    {!["sharepoint", "github"].includes(source.provider) && (
                      <LoomSelect
                        aria-label={`Import mode for ${source.name}`}
                        value={source.requestMode}
                        disabled={busy}
                        onChange={(event) =>
                          void act(async () => {
                            setSnapshot(
                              await call<SourceSnapshot>({
                                action: "request-mode",
                                id: source.id,
                                mode: event.target.value,
                              }),
                            );
                          })
                        }
                      >
                        <option value="detect">
                          Detect analytics requests
                        </option>
                        <option value="all">
                          Every post (dedicated intake)
                        </option>
                      </LoomSelect>
                    )}
                    {!!source.reviewCount && (
                      <details className="source-review">
                        <summary>
                          Review {source.reviewCount} possible request
                          {source.reviewCount === 1 ? "" : "s"}
                        </summary>
                        {source.review.map((candidate) => (
                          <article key={candidate.externalId}>
                            <strong>{candidate.title}</strong>
                            {candidate.text !== candidate.title && (
                              <p>{candidate.text}</p>
                            )}
                            <a
                              href={candidate.url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Open thread
                            </a>
                            <div className="source-actions">
                              {(["accept", "dismiss"] as const).map(
                                (decision) => (
                                  <button
                                    key={decision}
                                    disabled={busy || !source.active}
                                    onClick={() =>
                                      void act(async () => {
                                        setSnapshot(
                                          await call<SourceSnapshot>({
                                            action: "review",
                                            id: source.id,
                                            externalId: candidate.externalId,
                                            hash: candidate.hash,
                                            decision,
                                          }),
                                        );
                                        setNotice(
                                          decision === "accept"
                                            ? "Request imported."
                                            : "Message dismissed.",
                                        );
                                      })
                                    }
                                  >
                                    {decision === "accept"
                                      ? "Import request"
                                      : "Dismiss"}
                                  </button>
                                ),
                              )}
                            </div>
                          </article>
                        ))}
                        {source.reviewCount > source.review.length && (
                          <p className="hint">
                            Showing the first {source.review.length}. Review
                            these to see more.
                          </p>
                        )}
                      </details>
                    )}
                    {source.issues?.length > 0 && (
                      <details className="source-review">
                        <summary>Import details</summary>
                        {source.issues.map((issue, index) => (
                          <p key={index}>
                            <strong>{issue.title}</strong>
                            <br />
                            {issue.reason}
                          </p>
                        ))}
                        {source.skipped > source.issues.length && (
                          <p className="hint">
                            Showing the first {source.issues.length} files with
                            issues.
                          </p>
                        )}
                      </details>
                    )}
                    {source.error && (
                      <span className="source-error">{source.error}</span>
                    )}
                  </div>
                  <div className="source-actions">
                    <button
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          setSnapshot(
                            await call<SourceSnapshot>({
                              action: source.active ? "pause" : "resume",
                              id: source.id,
                            }),
                          );
                        })
                      }
                    >
                      {source.active ? "Pause" : "Resume"}
                    </button>
                    {source.active && (
                      <button
                        disabled={busy || source.syncing || !!source.error}
                        onClick={() =>
                          void act(async () => {
                            setSnapshot(
                              await call<SourceSnapshot>({
                                action: "sync",
                                id: source.id,
                              }),
                            );
                            setNotice("Sync queued.");
                          })
                        }
                      >
                        Sync now
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {snapshot.sources.length > 0 && (
            <p className="hint">
              Sync runs while the local Loom server is running. Pausing or
              disconnecting stops future imports; saved copies remain in the
              workspace.
            </p>
          )}
        </>
      )}
      <p role="status" aria-live="polite">
        {notice}
      </p>
    </section>
  );
}
