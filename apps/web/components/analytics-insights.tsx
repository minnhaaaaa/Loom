"use client";
import { LoomSelect } from "./ui/loom-select";
import { workspaceFetch } from "./workspace-fetch";

import { useEffect, useState } from "react";
import type { AnalyticsInsights as Insights } from "@loom/contracts";

const phaseLabels = {
  new: "New",
  needs_info: "Needs info",
  ready: "Ready",
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
  const [view, setView] = useState<"Flow" | "Stage time" | "Workload">("Flow");
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
  }, [days, refreshKey, revision]);

  const maxFlow = Math.max(
    1,
    ...(snapshot?.flow.flatMap((week) => [week.incoming, week.completions]) ||
      []),
  );
  const maxPhase = Math.max(
    1,
    ...(snapshot?.phases.map((phase) => phase.medianHours || 0) || []),
  );
  const maxOwner = Math.max(
    1,
    ...(snapshot?.owners.map((owner) => owner.open) || []),
  );

  return (
    <section
      className="analytics-insights"
      id="analytics-insights"
      aria-label="Request insights"
      aria-busy={busy}
    >
      <div className="insights-toolbar">
        <div className="insights-views" role="group" aria-label="Insight view">
          {(["Flow", "Stage time", "Workload"] as const).map((item) => (
            <button
              key={item}
              type="button"
              className="secondary"
              aria-pressed={view === item}
              onClick={() => setView(item)}
            >
              {item}
            </button>
          ))}
        </div>
        <LoomSelect
          aria-label="Reporting period"
          value={days}
          onChange={(event) => setDays(Number(event.target.value) as 30 | 90)}
        >
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
        </LoomSelect>
        <button
          type="button"
          className="quiet"
          disabled={busy}
          onClick={() => setRevision((value) => value + 1)}
        >
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {failure && (
        <p className="insights-error" role="alert">
          {failure}
        </p>
      )}
      {!snapshot && !failure && <p role="status">Loading insights…</p>}
      {snapshot && (
        <div className="insights-body">
          {view === "Flow" && (
            <section aria-labelledby="flow-insights-title">
              <div className="insights-chart-heading">
                <h2 id="flow-insights-title">Weekly requests</h2>
                <span>
                  <strong>{snapshot.flow.at(-1)?.endingBacklog ?? 0}</strong>{" "}
                  backlog at period end
                </span>
              </div>
              <div className="insights-legend">
                <span>
                  <i className="flow-incoming" />
                  Incoming
                </span>
                <span>
                  <i className="flow-completed" />
                  Completed
                </span>
              </div>
              {!snapshot.flow.some(
                (week) =>
                  week.incoming ||
                  week.completions ||
                  week.endingBacklog ||
                  week.cancellations ||
                  week.reopens,
              ) ? (
                <p className="insights-empty">No request activity yet.</p>
              ) : (
                <div
                  className="insights-chart-scroll"
                  tabIndex={0}
                  aria-label="Weekly incoming and completed requests"
                >
                  <div className="insights-flow-chart" role="list">
                    {snapshot.flow.map((week) => (
                      <div
                        className="insights-week"
                        key={week.weekStart}
                        role="listitem"
                        aria-label={`Week ${week.weekStart}: ${week.incoming} incoming, ${week.completions} completed, ${week.endingBacklog} backlog`}
                      >
                        <div className="insights-week-bars" aria-hidden="true">
                          <div
                            className="flow-incoming"
                            style={{
                              height: `${(week.incoming / maxFlow) * 100}%`,
                            }}
                          >
                            <span>{week.incoming}</span>
                          </div>
                          <div
                            className="flow-completed"
                            style={{
                              height: `${(week.completions / maxFlow) * 100}%`,
                            }}
                          >
                            <span>{week.completions}</span>
                          </div>
                        </div>
                        <time dateTime={week.weekStart}>
                          {new Date(
                            `${week.weekStart}T00:00:00Z`,
                          ).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                            timeZone: "UTC",
                          })}
                        </time>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <details className="insights-definition">
                <summary>View numbers</summary>
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
              </details>
            </section>
          )}
          {view === "Stage time" && (
            <section aria-labelledby="phase-insights-title">
              <div className="insights-chart-heading">
                <h2 id="phase-insights-title">Time in each stage</h2>
                <span>Median hours</span>
              </div>
              <div className="insights-horizontal-chart">
                {snapshot.phases.map((phase) => (
                  <div className="insights-bar-row" key={phase.status}>
                    <div className="insights-bar-label">
                      <span>{phaseLabels[phase.status]}</span>
                      <strong>{hours(phase.medianHours)}</strong>
                    </div>
                    <div className="insights-bar-track" aria-hidden="true">
                      <span
                        style={{
                          width: `${((phase.medianHours || 0) / maxPhase) * 100}%`,
                        }}
                      />
                    </div>
                    <small>{phase.requestCount} requests</small>
                  </div>
                ))}
              </div>
              <details className="insights-definition">
                <summary>View numbers</summary>
                <div className="insights-table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Stage</th>
                        <th>Requests</th>
                        <th>Median</th>
                        <th>90th percentile</th>
                        <th>Total elapsed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.phases.map((phase) => (
                        <tr key={phase.status}>
                          <th scope="row">{phaseLabels[phase.status]}</th>
                          <td>{phase.requestCount}</td>
                          <td>{hours(phase.medianHours)}</td>
                          <td>{hours(phase.p90Hours)}</td>
                          <td>{hours(phase.totalHours)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </section>
          )}
          {view === "Workload" && (
            <section aria-labelledby="owner-insights-title">
              <div className="insights-chart-heading">
                <h2 id="owner-insights-title">Open requests</h2>
                <span>Current · all dates</span>
              </div>
              <div className="insights-legend">
                <span>
                  <i className="age-new" />
                  Under 7 days
                </span>
                <span>
                  <i className="age-mid" />
                  7–14 days
                </span>
                <span>
                  <i className="age-old" />
                  14+ days
                </span>
              </div>
              {!snapshot.owners.length ? (
                <p className="insights-empty">No open requests.</p>
              ) : (
                <div className="insights-horizontal-chart">
                  {snapshot.owners.map((owner) => (
                    <div
                      className="insights-bar-row"
                      key={owner.ownerId || "unassigned"}
                    >
                      <div className="insights-bar-label">
                        <span>{owner.ownerName}</span>
                        <strong>{owner.open}</strong>
                      </div>
                      <div
                        className="insights-bar-track"
                        role="img"
                        aria-label={`${owner.under7Days} under 7 days, ${owner.days7To14} aged 7 to 14 days, ${owner.days14Plus} over 14 days`}
                      >
                        <span
                          className="age-new"
                          style={{
                            width: `${(owner.under7Days / maxOwner) * 100}%`,
                          }}
                        />
                        <span
                          className="age-mid"
                          style={{
                            width: `${(owner.days7To14 / maxOwner) * 100}%`,
                          }}
                        />
                        <span
                          className="age-old"
                          style={{
                            width: `${(owner.days14Plus / maxOwner) * 100}%`,
                          }}
                        />
                      </div>
                      <small>
                        {owner.overdue ? `${owner.overdue} overdue · ` : ""}
                        Oldest {hours(owner.oldestHours)}
                      </small>
                    </div>
                  ))}
                </div>
              )}
              {snapshot.hasMore.owners && (
                <p className="hint">Top 100 owners by open requests.</p>
              )}
            </section>
          )}
          <details className="insights-definition insights-method">
            <summary>About this data</summary>
            <p>
              {date(snapshot.from)} → {date(snapshot.asOf)} UTC.
            </p>
            <p>{snapshot.semantics.period}</p>
            <p>
              {view === "Flow"
                ? snapshot.semantics.flow
                : view === "Stage time"
                  ? snapshot.semantics.duration
                  : snapshot.semantics.workload}
            </p>
            <p>Calculated in Exasol.</p>
          </details>
          <details className="insights-evidence">
            <summary>Request details</summary>
            <p>Up to 50 requests. Charts include all qualifying requests.</p>
            {snapshot.records.length === 0 ? (
              <p>No contributing requests.</p>
            ) : (
              <div className="insights-table-scroll">
                <table>
                  <caption>
                    Saved request evidence · hours within the selected window
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
                          {record.firstEventVersion}–{record.lastEventVersion}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {snapshot.hasMore.records && (
              <p>
                More contributing requests exist. Only the first 50 are shown.
              </p>
            )}
            <details className="insights-definition">
              <summary>Calculation evidence</summary>

              <ul>
                {snapshot.evidence.map((item) => (
                  <li key={item.queryId}>
                    <code>{item.queryId}</code> · {item.returnedRows} returned
                    rows · {item.durationMs} ms
                    <small>SQL SHA-256: {item.sqlHash}</small>
                  </li>
                ))}
              </ul>
            </details>
          </details>
        </div>
      )}
    </section>
  );
}
