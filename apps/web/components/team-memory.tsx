"use client";
import { LoomSelect } from "./ui/loom-select";
import { workspaceFetch } from "./workspace-fetch";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { TeamMemorySnapshot } from "@loom/contracts";
import { KnowledgeGraph } from "./knowledge-graph";

const tabs = ["Graph", "Sources", "Timeline"] as const;
type View = (typeof tabs)[number];

export function TeamMemory({ refreshKey }: { refreshKey: string }) {
  const [view, setView] = useState<View>("Graph");
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
  }, [submitted, refreshKey, refresh, refreshCount]);

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

  const bounded = snapshot && Object.values(snapshot.hasMore).some(Boolean);

  return (
    <section
      id="team-memory"
      className="team-memory"
      aria-label="Team knowledge"
      aria-busy={busy}
    >
      <div className="memory-content">
        <form className="memory-search" onSubmit={search}>
          <label className="memory-search-field">
            <span className="sr-only">Search team knowledge</span>
            <input
              maxLength={200}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search knowledge…"
            />
          </label>
          <button type="submit" disabled={busy}>
            Search
          </button>
          <details className="memory-filters">
            <summary>Filters</summary>
            <div>
              <label>
                Knowledge type
                <LoomSelect
                  value={kind}
                  onChange={(event) => setKind(event.target.value)}
                >
                  <option value="all">All types</option>
                  <option value="procedure">Procedures</option>
                  <option value="routing">Routing guidance</option>
                  <option value="glossary">Glossary</option>
                  <option value="reference">Imported references</option>
                </LoomSelect>
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
            </div>
          </details>
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
        {!snapshot && !error && <p role="status">Loading knowledge…</p>}
        {snapshot && (
          <>
            {bounded && (
              <p className="memory-scope">
                Showing recent records. Search to narrow knowledge results.
              </p>
            )}
            {view === "Sources" && (
              <div
                className="memory-sources"
                aria-label="Approved knowledge results"
              >
                <p role="status">
                  {snapshot.entries.length} approved{" "}
                  {snapshot.entries.length === 1 ? "source" : "sources"}
                </p>
                {!snapshot.entries.length && (
                  <p className="memory-empty">
                    No sources found. Connect SharePoint in Settings or add team
                    guidance.
                  </p>
                )}
                {snapshot.entries.map(({ entry }) => (
                  <details key={entry.id} className="memory-source">
                    <summary className="memory-source-top">
                      <h3>{entry.title}</h3>
                      <span>{entry.kind}</span>
                    </summary>
                    <div className="memory-source-content">
                      <p className="source-text">{entry.content}</p>
                      {entry.externalSource && (
                        <div className="source-original">
                          <a
                            href={
                              entry.externalSource.page
                                ? `${entry.externalSource.url.split("#")[0]}#page=${entry.externalSource.page}`
                                : entry.externalSource.url
                            }
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open original
                            {entry.externalSource.page
                              ? ` · page ${entry.externalSource.page}`
                              : " in SharePoint"}
                          </a>
                          {entry.externalSource.truncated && (
                            <span>Document excerpt</span>
                          )}
                        </div>
                      )}
                      <p className="hint">
                        v{entry.version} · {entry.effectiveFrom}
                        {entry.effectiveUntil
                          ? ` → ${entry.effectiveUntil}`
                          : ""}
                      </p>
                      <button
                        type="button"
                        className="quiet"
                        onClick={() => {
                          setSelected(`knowledge:${entry.id}`);
                          setView("Graph");
                        }}
                      >
                        Show in graph
                      </button>
                    </div>
                  </details>
                ))}
              </div>
            )}
            {view === "Graph" && (
              <KnowledgeGraph
                snapshot={snapshot}
                selected={selected}
                onSelect={setSelected}
              />
            )}
            {view === "Timeline" && (
              <div
                className="memory-timeline"
                aria-label="Workspace decision timeline"
              >
                {!snapshot.timeline.length ? (
                  <p className="memory-empty">No saved activity yet.</p>
                ) : (
                  <ol>
                    {snapshot.timeline.map((event) => (
                      <li key={event.id}>
                        <span
                          className="memory-timeline-dot"
                          aria-hidden="true"
                        />
                        <div>
                          <strong>{event.action.replaceAll("_", " ")}</strong>
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
                          {new Date(event.createdAt).toLocaleString("en-IN")}
                        </time>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
