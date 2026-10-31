"use client";
import { workspaceFetch } from "./workspace-fetch";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { MemoryEdge, TeamMemorySnapshot } from "@loom/contracts";
import { ConsoleChrome } from "./ui/civitas";

const relationLabels: Record<MemoryEdge["relation"], string> = {
  requested_by: "Requested by",
  assigned_to: "Assigned to",
  owner_context: "Owner context",
  authored_by: "Authored by",
  approved_by: "Approved by",
  cites: "Cites source",
  proposes_for: "Proposes changes for",
  supersedes: "Replaces",
  learned_from: "Guidance drafted from",
};
const tabs = ["Sources", "Connections", "Timeline"] as const;
type View = (typeof tabs)[number];

export function TeamMemory({ refreshKey }: { refreshKey: string }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("Sources");
  const [snapshot, setSnapshot] = useState<TeamMemorySnapshot | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [dataset, setDataset] = useState("");
  const [asOf, setAsOf] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [refreshCount, setRefreshCount] = useState(0);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(
    async (parameters: string, signal?: AbortSignal) => {
      const response = await workspaceFetch(
        `/api/memory${parameters ? `?${parameters}` : ""}`,
        {
          cache: "no-store",
          signal,
        },
      );
      const data = await response.json();
      if (!response.ok)
        throw Object.assign(
          new Error(
            data.error?.message ||
              "Team memory could not be loaded. Try refreshing.",
          ),
          { status: response.status },
        );
      if (!signal?.aborted) {
        setSnapshot(data as TeamMemorySnapshot);
        setError("");
      }
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let running = false;
    const load = async () => {
      if (running || document.visibilityState === "hidden") return;
      running = true;
      setBusy(true);
      try {
        await refresh(submitted, controller.signal);
      } catch (cause) {
        if (controller.signal.aborted) return;
        // A failed authorization must not leave old internal context visible.
        if (
          [401, 403].includes(Number((cause as { status?: number }).status))
        ) {
          setSnapshot(null);
          setSelected("");
        }
        setError(
          cause instanceof Error
            ? cause.message
            : "Team memory could not be loaded.",
        );
      } finally {
        running = false;
        if (!controller.signal.aborted) setBusy(false);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 15000);
    window.addEventListener("focus", load);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [open, submitted, refreshKey, refresh, refreshCount]);

  function search(event: FormEvent) {
    event.preventDefault();
    const parameters = new URLSearchParams();
    if (query.trim()) parameters.set("q", query.trim());
    if (kind !== "all") parameters.set("kind", kind);
    if (dataset.trim()) parameters.set("dataset", dataset.trim());
    if (asOf) parameters.set("asOf", asOf);
    const next = parameters.toString();
    if (next === submitted) {
      // Keep refreshes within the abortable effect, including repeated searches.
      setRefreshCount((count) => count + 1);
    } else setSubmitted(next);
    setView("Sources");
  }

  const graph = snapshot?.graph;
  const node =
    graph?.nodes.find((item) => item.id === selected) ||
    graph?.nodes.find((item) => item.kind === "request") ||
    graph?.nodes[0];
  const connections =
    graph?.edges.filter(
      (edge) => edge.from === node?.id || edge.to === node?.id,
    ) || [];
  const bounded = snapshot && Object.values(snapshot.hasMore).some(Boolean);

  return (
    <details
      id="team-memory"
      className="team-memory"
      onToggle={(event) => {
        if (event.target === event.currentTarget)
          setOpen(event.currentTarget.open);
      }}
    >
      <summary className="memory-entry">
        <span>
          <strong>Team brain</strong>
          <span>
            Approved knowledge, connected records, and the decisions behind the
            work.
          </span>
        </span>
      </summary>
      {open && (
        <div className="memory-body">
          <ConsoleChrome
            label="Loom / team memory"
            status={busy ? "Refreshing…" : "Saved evidence"}
          />
          <div className="memory-content">
            <div className="memory-heading">
              <div>
                <p className="eyebrow">Know why, not just what</p>
                <h2>Give the work its context.</h2>
              </div>
              <a
                href="#agent-knowledge"
                onClick={() => {
                  const knowledge = document.getElementById("agent-knowledge");
                  if (knowledge instanceof HTMLDetailsElement)
                    knowledge.open = true;
                }}
              >
                Add team knowledge
              </a>
            </div>
            <p className="hint">
              Search approved guidance. Explore relationships recorded in your
              workspace and see what changed. Suggestions remain proposals until
              someone approves them.
            </p>
            <form className="memory-search" onSubmit={search}>
              <label>
                Search team knowledge
                <input
                  maxLength={200}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Onboarding, routing, a source ID…"
                />
              </label>
              <label>
                Knowledge type
                <select
                  value={kind}
                  onChange={(event) => setKind(event.target.value)}
                >
                  <option value="all">All types</option>
                  <option value="procedure">Procedures</option>
                  <option value="routing">Routing guidance</option>
                  <option value="glossary">Glossary</option>
                </select>
              </label>
              <label>
                Context or dataset
                <input
                  maxLength={200}
                  value={dataset}
                  onChange={(event) => setDataset(event.target.value)}
                  placeholder="Any context"
                />
              </label>
              <label>
                Valid on date
                <input
                  type="date"
                  value={asOf}
                  onChange={(event) => setAsOf(event.target.value)}
                />
              </label>
              <button type="submit" disabled={busy}>
                Search knowledge
              </button>
            </form>
            {error && (
              <p className="alert" role="alert">
                {error}
              </p>
            )}
            <div
              className="memory-views"
              role="group"
              aria-label="Team memory view"
            >
              {tabs.map((tab) => (
                <button
                  key={tab}
                  className="secondary"
                  aria-pressed={view === tab}
                  onClick={() => setView(tab)}
                >
                  {tab}
                </button>
              ))}
            </div>
            {!snapshot && !error && (
              <p role="status">Loading saved workspace evidence…</p>
            )}
            {snapshot && (
              <>
                <p className="memory-scope">
                  Sources are approved now and valid on {snapshot.asOf}. Search
                  filters scope knowledge in sources and connections. Records
                  and timeline show a recent workspace snapshot.
                </p>
                {bounded && (
                  <p className="banner compact">
                    This is a bounded snapshot. More saved records exist than
                    are shown here; narrow your source search for relevant
                    guidance.
                  </p>
                )}
                {view === "Sources" && (
                  <div
                    className="memory-sources"
                    aria-label="Approved knowledge results"
                  >
                    <p role="status">
                      {snapshot.entries.length} matching{" "}
                      {snapshot.entries.length === 1 ? "source" : "sources"}
                    </p>
                    {!snapshot.entries.length && (
                      <div className="memory-empty">
                        <h3>No approved guidance matches yet.</h3>
                        <p>
                          Add a procedure or glossary entry in Team knowledge,
                          then have an owner approve it. Draft and retired
                          guidance stays out of the agent’s approved context.
                        </p>
                      </div>
                    )}
                    {snapshot.entries.map(({ entry, matchedBy }) => (
                      <article key={entry.id} className="memory-source">
                        <div className="memory-source-top">
                          <h3>{entry.title}</h3>
                          <span>
                            {entry.kind} · v{entry.version}
                          </span>
                        </div>
                        <p className="hint">
                          Matched by {matchedBy.join(", ")} · valid from{" "}
                          {entry.effectiveFrom}
                          {entry.effectiveUntil
                            ? ` to ${entry.effectiveUntil}`
                            : ""}
                        </p>
                        <p className="source-text">{entry.content}</p>
                        {entry.provenance && (
                          <p className="hint">
                            Drafted from a reviewed decision. The owner approved
                            this guidance separately.
                          </p>
                        )}
                        <details>
                          <summary>Source identity and connections</summary>
                          <p className="memory-identifier">
                            Source {entry.id} · version {entry.version}
                          </p>
                          <button
                            className="quiet"
                            onClick={() => {
                              setSelected(`knowledge:${entry.id}`);
                              setView("Connections");
                            }}
                          >
                            Explore connections
                          </button>
                        </details>
                      </article>
                    ))}
                  </div>
                )}
                {view === "Connections" && (
                  <div
                    className="memory-connections"
                    aria-label="Saved relationship map"
                  >
                    <p className="hint">
                      Every connection below comes from a saved record or an
                      explicit source reference. Citations record what a
                      proposal cited; they do not prove its reasoning.
                    </p>
                    {!graph?.nodes.length ? (
                      <p className="memory-empty">
                        Save a request or approve team knowledge to start
                        building your team’s map.
                      </p>
                    ) : (
                      <>
                        <label>
                          Explore a saved item
                          <select
                            value={node?.id || ""}
                            onChange={(event) =>
                              setSelected(event.target.value)
                            }
                          >
                            {graph.nodes.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.kind} · {item.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        {node && (
                          <div className="memory-map">
                            <div className="memory-map-center">
                              <span>{node.kind}</span>
                              <h3>{node.label}</h3>
                              <small>
                                {node.state || "Saved record"}
                                {node.version ? ` · v${node.version}` : ""}
                              </small>
                            </div>
                            <div className="memory-map-links">
                              {!connections.length && (
                                <p>No recorded connections in this snapshot.</p>
                              )}
                              {connections.map((edge) => {
                                const outgoing = edge.from === node.id;
                                const neighbour = graph.nodes.find(
                                  (item) =>
                                    item.id ===
                                    (outgoing ? edge.to : edge.from),
                                );
                                return (
                                  <article
                                    key={edge.id}
                                    className="memory-map-link"
                                  >
                                    <span className="memory-relation">
                                      {outgoing ? "→" : "←"}{" "}
                                      {relationLabels[edge.relation]}
                                    </span>
                                    <button
                                      className="quiet"
                                      onClick={() =>
                                        setSelected(neighbour?.id || "")
                                      }
                                    >
                                      <span>{neighbour?.kind}</span>
                                      <strong>
                                        {neighbour?.label || "Unavailable item"}
                                      </strong>
                                    </button>
                                    <details>
                                      <summary>
                                        Inspect recorded evidence
                                      </summary>
                                      <p className="memory-identifier">
                                        {edge.evidence.source} ·{" "}
                                        {edge.evidence.resourceId} · v
                                        {edge.evidence.version}
                                        {edge.evidence.targetVersion
                                          ? ` · cited target v${edge.evidence.targetVersion}`
                                          : ""}
                                      </p>
                                    </details>
                                  </article>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
                {view === "Timeline" && (
                  <div
                    className="memory-timeline"
                    aria-label="Workspace decision timeline"
                  >
                    {!snapshot.timeline.length ? (
                      <p className="memory-empty">
                        Saved activity will appear here as your team works.
                      </p>
                    ) : (
                      <ol>
                        {snapshot.timeline.map((event) => (
                          <li key={event.id}>
                            <span
                              className="memory-timeline-dot"
                              aria-hidden="true"
                            />
                            <div>
                              <strong>
                                {event.action.replaceAll("_", " ")}
                              </strong>
                              <p>
                                {event.actorName} · version {event.version}
                              </p>
                              <details>
                                <summary>Record identity</summary>
                                <p className="memory-identifier">
                                  {event.resourceId}
                                </p>
                              </details>
                            </div>
                            <time dateTime={event.createdAt}>
                              {new Date(event.createdAt).toLocaleString(
                                "en-IN",
                              )}
                            </time>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                )}
                <p className="memory-scope">
                  Snapshot refreshed{" "}
                  {new Date(snapshot.queriedAt).toLocaleTimeString("en-IN")} ·
                  updates while this panel is open.
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </details>
  );
}
