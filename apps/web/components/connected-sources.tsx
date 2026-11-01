"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  SourceOption,
  SourceProvider,
  SourceSnapshot,
} from "@loom/contracts";
import { accessRequest } from "./account-access";
import { LoomSelect } from "./ui/loom-select";

type Signin = {
  id: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  interval: number;
};
const labels: Record<SourceProvider, string> = {
  slack: "Slack",
  teams: "Microsoft Teams",
  sharepoint: "SharePoint",
};
export function ConnectedSources({ workspaceId }: { workspaceId: string }) {
  return <SourceSettings key={workspaceId} workspaceId={workspaceId} />;
}
function SourceSettings({ workspaceId }: { workspaceId: string }) {
  const setupHelp = useRef<HTMLDetailsElement>(null);
  const id = useId(),
    alive = useRef(true),
    pending = useRef(false);
  const [snapshot, setSnapshot] = useState<SourceSnapshot | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [token, setToken] = useState(""),
    [signin, setSignin] = useState<Signin | null>(null);
  const [provider, setProvider] = useState<SourceProvider>("slack"),
    [parentId, setParentId] = useState(""),
    [rootId, setRootId] = useState("");
  const [parents, setParents] = useState<SourceOption[]>([]),
    [options, setOptions] = useState<SourceOption[]>([]),
    [query, setQuery] = useState("");
  const [requestMode, setRequestMode] = useState<"detect" | "all">("detect");
  const [shared, setShared] = useState(false),
    [notice, setNotice] = useState("");
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
  useEffect(() => {
    if (!signin) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (Date.now() >= Date.parse(signin.expiresAt)) {
        setSignin(null);
        setError("Microsoft sign-in expired. Connect again.");
        return;
      }
      try {
        const result = await call<{ connected: boolean }>(
          { action: "poll-microsoft", id: signin.id },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (result.connected) {
          setSnapshot(await call<SourceSnapshot>(undefined, controller.signal));
          setSignin(null);
          setNotice("Microsoft connected. Choose your channels or libraries.");
          return;
        }
        timer = setTimeout(() => {
          void poll();
        }, signin.interval * 1000);
      } catch (cause) {
        if (!controller.signal.aborted) {
          setSignin(null);
          setError(
            cause instanceof Error
              ? cause.message
              : "Microsoft sign-in failed.",
          );
        }
      }
    };
    timer = setTimeout(() => {
      void poll();
    }, signin.interval * 1000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [signin, call]);
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
  async function loadOptions(selected: SourceProvider, parent = "") {
    const result = await call<{ options: SourceOption[] }>({
      action: "browse",
      provider: selected,
      parentId: parent,
      query,
    });
    if (!alive.current) return;
    if (selected === "slack" || parent) setOptions(result.options);
    else setParents(result.options);
    if (!result.options.length)
      setNotice(
        selected === "slack"
          ? "No public channels found. Invite the Slack app to an intake channel."
          : "No matching sources found.",
      );
  }
  const slackConnection = snapshot?.connections.find(
    (value) => value.provider === "slack",
  );
  const microsoftConnection = snapshot?.connections.find(
    (value) => value.provider === "microsoft",
  );
  const connected =
    provider === "slack" ? slackConnection : microsoftConnection;
  return (
    <section
      className="connected-sources"
      id="connected-sources"
      aria-labelledby={`${id}-heading`}
    >
      <h2 id={`${id}-heading`}>Connected sources</h2>
      <p className="hint">
        Requests from Slack and Teams. References from SharePoint.
      </p>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {!snapshot && !error && <p role="status">Loading connections…</p>}
      {snapshot && (
        <>
          <div className="source-connections">
            <div className="source-connection">
              <div>
                <strong>Slack</strong>
                <span>{slackConnection?.name || "Not connected"}</span>
              </div>
              {slackConnection ? (
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      setSnapshot(
                        await call<SourceSnapshot>({
                          action: "disconnect",
                          provider: "slack",
                        }),
                      );
                      setOptions([]);
                    })
                  }
                >
                  Disconnect Slack
                </button>
              ) : (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act(async () => {
                      setSnapshot(
                        await call<SourceSnapshot>({
                          action: "connect-slack",
                          token,
                        }),
                      );
                      setToken("");
                      setNotice("Slack connected. Choose an intake channel.");
                    });
                  }}
                >
                  <label className="sr-only" htmlFor={`${id}-slack-token`}>
                    Slack app token
                  </label>
                  <input
                    id={`${id}-slack-token`}
                    type="password"
                    autoComplete="off"
                    placeholder="Slack app token"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    disabled={busy}
                  />
                  <button disabled={busy || !token.trim()}>
                    Connect Slack
                  </button>
                </form>
              )}
            </div>
            <div className="source-connection">
              <div>
                <strong>Teams &amp; SharePoint</strong>
                <span>{microsoftConnection?.name || "Not connected"}</span>
              </div>
              {microsoftConnection ? (
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      setSnapshot(
                        await call<SourceSnapshot>({
                          action: "disconnect",
                          provider: "microsoft",
                        }),
                      );
                      setSignin(null);
                      setOptions([]);
                      setParents([]);
                    })
                  }
                >
                  Disconnect Microsoft
                </button>
              ) : (
                <button
                  disabled={busy || !!signin}
                  onClick={() => {
                    if (!snapshot.microsoftAvailable) {
                      if (setupHelp.current) {
                        setupHelp.current.open = true;
                        setupHelp.current.querySelector("summary")?.focus();
                      }
                      return;
                    }
                    void act(async () => {
                      setSignin(
                        await call<Signin>({ action: "connect-microsoft" }),
                      );
                    });
                  }}
                >
                  {snapshot.microsoftAvailable
                    ? "Connect Microsoft"
                    : "Set up Microsoft"}
                </button>
              )}
            </div>
          </div>
          {signin && (
            <div className="source-signin" role="status">
              <span>Enter this code on Microsoft’s sign-in page:</span>
              <strong>{signin.userCode}</strong>
              <a href={signin.verificationUri} target="_blank" rel="noreferrer">
                Continue to Microsoft
              </a>
              <button className="quiet" onClick={() => setSignin(null)}>
                Close
              </button>
            </div>
          )}
          <details ref={setupHelp} className="source-setup-help">
            <summary>Connection setup</summary>
            <p>
              Slack: install an app with <code>channels:read</code> and{" "}
              <code>channels:history</code>, invite it to a public intake
              channel, then paste its OAuth token above. Thread access must be
              allowed by the token.
            </p>
            <p>
              Microsoft: register a public client in your company’s Entra tenant
              and allow device sign-in. Set{" "}
              <code>LOOM_MICROSOFT_CLIENT_ID</code> and{" "}
              <code>LOOM_MICROSOFT_TENANT_ID</code> on the local server, grant
              the read permissions listed in <code>CONNECTED_SOURCES.md</code>,
              then restart Loom.
            </p>
            <p>
              {snapshot.microsoftAvailable
                ? "Microsoft app configured."
                : "Microsoft app setup is required before connecting."}{" "}
              Connections read content only. They do not send messages.
            </p>
          </details>
          {!snapshot.syncEnabled && (
            <p role="status">
              Automatic sync is disabled on this server. Enable LOOM_SOURCE_SYNC
              to start imports.
            </p>
          )}
          {snapshot.connections.length > 0 && (
            <details
              className="source-add"
              open={snapshot.sources.length === 0}
            >
              <summary>Add a source</summary>
              <form
                className="source-selection"
                onSubmit={(event) => {
                  event.preventDefault();
                  void act(async () => {
                    setSnapshot(
                      await call<SourceSnapshot>({
                        action: "select",
                        selection: {
                          provider,
                          parentId,
                          rootId,
                          shareWithWorkspace: shared,
                          requestMode,
                        },
                      }),
                    );
                    setRootId("");
                    setShared(false);
                    setNotice(
                      "Source added. Sync starts while Loom is running.",
                    );
                  });
                }}
              >
                <div className="source-picker-row">
                  <label>
                    Service
                    <LoomSelect
                      value={provider}
                      disabled={busy}
                      onChange={(event) => {
                        setProvider(event.target.value as SourceProvider);
                        setParentId("");
                        setRootId("");
                        setParents([]);
                        setOptions([]);
                        setShared(false);
                      }}
                    >
                      <option value="slack">Slack</option>
                      <option value="teams">Microsoft Teams</option>
                      <option value="sharepoint">SharePoint</option>
                    </LoomSelect>
                  </label>
                  {provider === "sharepoint" && (
                    <label>
                      Find a site
                      <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Site name"
                        disabled={busy}
                      />
                    </label>
                  )}
                  <button
                    type="button"
                    disabled={
                      busy ||
                      !connected ||
                      (provider === "sharepoint" && query.trim().length < 2)
                    }
                    onClick={() => void act(() => loadOptions(provider))}
                  >
                    {provider === "slack"
                      ? "Load channels"
                      : provider === "teams"
                        ? "Load teams"
                        : "Find sites"}
                  </button>
                </div>
                {provider !== "slack" && parents.length > 0 && (
                  <label>
                    {provider === "teams" ? "Team" : "Site"}
                    <LoomSelect
                      value={parentId}
                      disabled={busy}
                      onChange={(event) => {
                        const value = event.target.value;
                        setParentId(value);
                        setRootId("");
                        setOptions([]);
                        if (value) void act(() => loadOptions(provider, value));
                      }}
                    >
                      <option value="">
                        Choose {provider === "teams" ? "a team" : "a site"}
                      </option>
                      {parents.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.name}
                        </option>
                      ))}
                    </LoomSelect>
                  </label>
                )}
                {options.length > 0 && (
                  <>
                    <label>
                      {provider === "sharepoint"
                        ? "Document library"
                        : "Channel"}
                      <LoomSelect
                        value={rootId}
                        disabled={busy}
                        onChange={(event) => setRootId(event.target.value)}
                      >
                        <option value="">
                          Choose{" "}
                          {provider === "sharepoint"
                            ? "a library"
                            : "a channel"}
                        </option>
                        {options.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.name}
                          </option>
                        ))}
                      </LoomSelect>
                    </label>
                    {provider !== "sharepoint" && (
                      <label>
                        Import
                        <LoomSelect
                          value={requestMode}
                          disabled={busy}
                          onChange={(event) =>
                            setRequestMode(
                              event.target.value as "detect" | "all",
                            )
                          }
                        >
                          <option value="detect">
                            Detect analytics requests
                          </option>
                          <option value="all">
                            Every post (dedicated intake)
                          </option>
                        </LoomSelect>
                      </label>
                    )}
                    <label className="source-share">
                      <input
                        type="checkbox"
                        checked={shared}
                        onChange={(event) => setShared(event.target.checked)}
                        disabled={busy}
                      />
                      Share this source with this Loom workspace.
                    </label>
                    <p className="hint">
                      {provider === "sharepoint"
                        ? "PDF, Word and text documents become searchable references. Choose a library all owners and analysts may read."
                        : "Imported requests are visible to owners, analysts and viewers. Detection uses English rules; uncertain matches wait for review."}
                    </p>
                    <button disabled={busy || !rootId || !shared}>
                      Start automatic import
                    </button>
                  </>
                )}
              </form>
            </details>
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
                    {source.provider !== "sharepoint" && (
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
              Sync runs while Loom is open on this computer. Pausing or
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
