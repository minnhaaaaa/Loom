"use client";
import { workspaceFetch } from "./workspace-fetch";

import { useEffect, useState } from "react";
import type { AnalyticsInsights as Insights } from "@loom/contracts";

const phaseLabels = {
  new: "New / awaiting triage",
  needs_info: "Awaiting information",
  ready: "Ready / queued",
  in_progress: "In progress",
};
const hours = (value: number | null) =>
  value === null
    ? "—"
    : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} h`;
const date = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  });

export function AnalyticsInsights({ refreshKey }: { refreshKey: string }) {
  const [open, setOpen] = useState(true);
  const [days, setDays] = useState<30 | 90>(30);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    days: 30 | 90;
    data: Insights;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const snapshot =
    result?.key === refreshKey && result.days === days ? result.data : null;

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let running = false;
    async function load() {
      if (running || document.visibilityState === "hidden") return;
      running = true;
      setBusy(true);
      try {
        const response = await workspaceFetch(`/api/insights?days=${days}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok)
          throw new Error(
            data.error?.message || "Insights could not be loaded. Try again.",
          );
        if (controller.signal.aborted) return;
        setResult({ key: refreshKey, days, data });
        setFailure("");
      } catch (cause) {
        if (controller.signal.aborted) return;
        // Clear prior analytical data on every failed refresh, including revoked access.
        setResult(null);
        setFailure(
          cause instanceof Error
            ? cause.message
            : "Insights could not be loaded.",
        );
      } finally {
        running = false;
        if (!controller.signal.aborted) setBusy(false);
      }
    }
    void load();
    const timer = setInterval(() => void load(), 30000);
    window.addEventListener("focus", load);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [open, days, refreshKey, revision]);

  return (
    <details
      open={open}
      className="analytics-insights"
      id="analytics-insights"
      onToggle={(event) => {
        if (event.target === event.currentTarget)
          setOpen(event.currentTarget.open);
      }}
    >
      <summary className="insights-entry">
        <span>
          <strong>Where requests get stuck</strong>
          <span>
            Waiting time, weekly flow, and the work on each analyst’s desk.
          </span>
        </span>
      </summary>
      {open && (
        <div className="insights-body" aria-busy={busy}>
          <div className="insights-toolbar">
            <label>
              Reporting period
              <select
                value={days}
                onChange={(event) =>
                  setDays(Number(event.target.value) as 30 | 90)
                }
              >
                <option value="30">Last 30 days</option>
                <option value="90">Last 90 days</option>
              </select>
            </label>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setRevision((value) => value + 1)}
            >
              {busy ? "Refreshing…" : "Refresh insights"}
            </button>
            <span className="insights-engine">Calculated in Exasol</span>
          </div>
          {failure && (
            <p className="insights-error" role="alert">
              {failure}
            </p>
          )}
          {!snapshot && !failure && (
            <p role="status">Loading saved request history…</p>
          )}
          {snapshot && (
            <>
              <p className="insights-period">
                {date(snapshot.from)} → {date(snapshot.asOf)} UTC.{" "}
                {snapshot.semantics.period}
              </p>
              {snapshot.phases.every((phase) => phase.requestCount === 0) && (
                <p className="insights-empty">
                  No elapsed request activity in this period. Submit a request
                  or import a backlog to begin measuring the workflow.
                </p>
              )}
              <section aria-labelledby="phase-insights-title">
                <h3 id="phase-insights-title">Time in each stage</h3>
                <p>
                  Each sample is one request’s total elapsed time in a stage
                  during this period, including work still open.
                </p>
                <div className="insights-phases">
                  {snapshot.phases.map((phase) => (
                    <article key={phase.status}>
                      <span>{phaseLabels[phase.status]}</span>
                      <strong>{hours(phase.medianHours)}</strong>
                      <span>median · {phase.requestCount} requests</span>
                      <dl>
                        <div>
                          <dt>90th percentile</dt>
                          <dd>{hours(phase.p90Hours)}</dd>
                        </div>
                        <div>
                          <dt>Total elapsed</dt>
                          <dd>{hours(phase.totalHours)}</dd>
                        </div>
                      </dl>
                    </article>
                  ))}
                </div>
                <details className="insights-definition">
                  <summary>How stage time is measured</summary>
                  <p>{snapshot.semantics.duration}</p>
                </details>
              </section>
              <section aria-labelledby="flow-insights-title">
                <h3 id="flow-insights-title">Is the backlog growing?</h3>
                <p>{snapshot.semantics.flow}</p>
                <div className="insights-table-scroll">
                  <table>
                    <caption>
                      Weekly request flow · UTC weeks start Monday
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Week starting</th>
                        <th scope="col">Incoming</th>
                        <th scope="col">Completions</th>
                        <th scope="col">Cancelled</th>
                        <th scope="col">Reopened</th>
                        <th scope="col">Ending backlog</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.flow.map((week) => (
                        <tr key={week.weekStart}>
                          <th scope="row">{week.weekStart}</th>
                          <td>{week.incoming}</td>
                          <td>{week.completions}</td>
                          <td>{week.cancellations}</td>
                          <td>{week.reopens}</td>
                          <td>
                            <strong>{week.endingBacklog}</strong>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
              <section aria-labelledby="owner-insights-title">
                <h3 id="owner-insights-title">Current workload by owner</h3>
                <p>{snapshot.semantics.workload}</p>
                {snapshot.owners.length === 0 ? (
                  <p className="insights-empty">
                    No open requests in this workspace.
                  </p>
                ) : (
                  <div className="insights-table-scroll">
                    <table>
                      <caption>
                        Open requests of every age · independent of the
                        reporting period
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Owner</th>
                          <th scope="col">Open</th>
                          <th scope="col">Overdue</th>
                          <th scope="col">Under 7 days</th>
                          <th scope="col">7–14 days</th>
                          <th scope="col">14+ days</th>
                          <th scope="col">Oldest</th>
                        </tr>
                      </thead>
                      <tbody>
                        {snapshot.owners.map((owner) => (
                          <tr key={owner.ownerId || "unassigned"}>
                            <th scope="row">{owner.ownerName}</th>
                            <td>{owner.open}</td>
                            <td>{owner.overdue}</td>
                            <td>{owner.under7Days}</td>
                            <td>{owner.days7To14}</td>
                            <td>{owner.days14Plus}</td>
                            <td>{hours(owner.oldestHours)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {snapshot.hasMore.owners && (
                  <p>Showing the 100 owners with the most open requests.</p>
                )}
              </section>
              <details className="insights-evidence">
                <summary>Inspect the requests behind the stage totals</summary>
                <p>
                  Up to 50 requests with the most elapsed active time. Stage
                  statistics above include every qualifying request; this
                  evidence sample is bounded. Event versions identify the saved
                  history used.
                </p>
                {snapshot.records.length === 0 ? (
                  <p>No contributing requests.</p>
                ) : (
                  <div className="insights-table-scroll">
                    <table>
                      <caption>
                        Saved request evidence · hours within the selected
                        window
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Request</th>
                          <th scope="col">New</th>
                          <th scope="col">Information</th>
                          <th scope="col">Ready</th>
                          <th scope="col">In progress</th>
                          <th scope="col">Event versions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {snapshot.records.map((record) => (
                          <tr key={record.id}>
                            <th scope="row">
                              {record.title}
                              <small>{record.id}</small>
                            </th>
                            <td>{hours(record.newHours)}</td>
                            <td>{hours(record.needsInfoHours)}</td>
                            <td>{hours(record.readyHours)}</td>
                            <td>{hours(record.inProgressHours)}</td>
                            <td>
                              {record.firstEventVersion}–
                              {record.lastEventVersion}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {snapshot.hasMore.records && (
                  <p>
                    More contributing requests exist. Only the first 50 are
                    shown.
                  </p>
                )}
                <details className="insights-definition">
                  <summary>Calculation evidence</summary>
                  <p>
                    Read-only, versioned SQL with workspace filtering. Timing
                    includes database transport and is not a database benchmark.
                  </p>
                  <ul>
                    {snapshot.evidence.map((item) => (
                      <li key={item.queryId}>
                        <code>{item.queryId}</code> · {item.returnedRows}{" "}
                        returned rows · {item.durationMs} ms
                        <small>SQL SHA-256: {item.sqlHash}</small>
                      </li>
                    ))}
                  </ul>
                </details>
              </details>
            </>
          )}
        </div>
      )}
    </details>
  );
}
