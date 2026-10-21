"use client";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  personas,
  statuses,
  statusLabels,
  toolSpec,
  type AnalyticsResult,
  type Command,
  type DeskSnapshot,
  type Intake,
  type PublicRequest,
  type RequestDetails,
  type Status,
} from "@loom/contracts";

type Detail = {
  request: PublicRequest;
  comments: RequestDetails["comments"];
  activity: RequestDetails["activity"];
};
class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
  ) {
    super(message);
  }
}
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const body = await response.json();
  if (!response.ok)
    throw new ApiError(
      body.error?.message || "The request could not be completed.",
      body.error?.code || "UNKNOWN",
      response.status,
    );
  return body as T;
}
function date(value: string | null) {
  return value
    ? new Date(
        value.length === 10 ? value + "T00:00:00Z" : value,
      ).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      })
    : "No due date";
}
function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`status status-${status}`}>
      <span aria-hidden="true" />
      {statusLabels[status]}
    </span>
  );
}
const emptyIntake: Intake = {
  title: "",
  businessQuestion: "",
  reportingPeriod: "",
  dataset: "",
};
export function Desk({
  initial,
  initialError,
}: {
  initial: DeskSnapshot;
  initialError: string | null;
}) {
  const [desk, setDesk] = useState(initial),
    [error, setError] = useState(initialError),
    [notice, setNotice] = useState("");
  const [search, setSearch] = useState(""),
    [status, setStatus] = useState("all"),
    [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null),
    [detailLoading, setDetailLoading] = useState(false);
  const [creating, setCreating] = useState(false),
    [busy, setBusy] = useState(false),
    [analytics, setAnalytics] = useState<AnalyticsResult | null>(null);
  const [detailRevision, setDetailRevision] = useState(0);
  const [intake, setIntake] = useState<Intake>(emptyIntake);
  const [comment, setComment] = useState(""),
    [visibility, setVisibility] = useState<"internal" | "requester_visible">(
      "requester_visible",
    );
  const pendingCommand = useRef<{ payload: string; id: string } | null>(null);
  const preview = desk.mode === "preview",
    member = desk.membership;
  const memberId = member?.userId;
  const operates = member?.role === "owner" || member?.role === "operator";
  const canWrite = !preview && Boolean(member) && member?.role !== "viewer";
  const refresh = useCallback(async () => {
    try {
      const next = await api<DeskSnapshot>("/api/desk");
      setDesk(next);
      setError(null);
      if (next.membership?.role !== "requester") {
        try {
          setAnalytics(await api<AnalyticsResult>("/api/analytics"));
        } catch {
          setAnalytics(null);
        }
      } else setAnalytics(null);
    } catch (e) {
      if (e instanceof ApiError && [401, 403].includes(e.status)) {
        setDesk((d) => ({ ...d, membership: null, requests: [], members: [] }));
        setSelected(null);
        setDetail(null);
        setAnalytics(null);
      }
      setError(e instanceof Error ? e.message : "Could not refresh.");
    }
  }, []);
  useEffect(() => {
    if (preview || !memberId) return;
    const timer = setInterval(() => void refresh(), 15_000);
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    const firstPoll = setTimeout(() => void refresh(), 0);
    return () => {
      clearInterval(timer);
      clearTimeout(firstPoll);
      window.removeEventListener("focus", focus);
    };
  }, [preview, memberId, refresh]); // Identity is the polling boundary.
  useEffect(() => {
    if (!selected || preview) return;
    const controller = new AbortController();
    api<Detail>(`/api/requests/${selected}`, { signal: controller.signal })
      .then((data) => {
        setDetail(data);
        setIntake(data.request);
        setError(null);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [selected, preview, detailRevision]);
  useEffect(() => {
    if (!creating && !selected) return;
    const before = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      if (before instanceof HTMLElement) before.focus();
    };
  }, [creating, selected]);
  async function signIn(userId: string) {
    setBusy(true);
    setError(null);
    try {
      await api("/api/session", {
        method: "POST",
        body: JSON.stringify({ userId }),
      });
      setDesk((d) => ({ ...d, membership: null, requests: [], members: [] }));
      setSelected(null);
      setDetail(null);
      setAnalytics(null);
      pendingCommand.current = null;
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    setBusy(true);
    try {
      await api("/api/session", { method: "DELETE", body: "{}" });
      setDesk((d) => ({ ...d, membership: null, requests: [], members: [] }));
      setSelected(null);
      setAnalytics(null);
      setNotice("Signed out.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function submit(path: string, payload: object): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice("");
    const serialized = JSON.stringify({ path, ...payload });
    if (pendingCommand.current?.payload !== serialized)
      pendingCommand.current = { payload: serialized, id: crypto.randomUUID() };
    try {
      await api(path, {
        method: "POST",
        body: JSON.stringify({
          ...payload,
          commandId: pendingCommand.current.id,
        }),
      });
      pendingCommand.current = null;
      await refresh();
      setDetailRevision((v) => v + 1);
      setNotice("Changes saved.");
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!canWrite) return;
    if (await submit("/api/requests", { values: intake })) {
      setCreating(false);
      setIntake(emptyIntake);
    }
  }
  async function command(value: Command) {
    if (!detail || !canWrite) return;
    const saved = await submit(`/api/requests/${detail.request.id}/commands`, {
      expectedVersion: detail.request.version,
      command: value,
    });
    if (saved && value.type === "add_comment") setComment("");
  }
  const filtered = desk.requests.filter(
    (r) =>
      (status === "all" || r.status === status) &&
      `${r.title} ${r.businessQuestion} ${r.requesterName} ${r.ownerName || ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const open = desk.requests.filter(
    (r) => !["done", "cancelled"].includes(r.status),
  );
  const own = member?.role === "requester";
  const stats = analytics
    ? [
        { label: "Open requests", value: analytics.open },
        { label: "Overdue", value: analytics.overdue },
        { label: "Unassigned", value: analytics.unassigned },
        { label: "Missing requirements", value: analytics.incomplete },
      ]
    : [
        { label: "Visible requests", value: desk.requests.length },
        { label: "Open in this list", value: open.length },
        {
          label: "Unassigned in this list",
          value: open.filter((r) => !r.ownerId).length,
        },
        {
          label: "Needs information",
          value: open.filter((r) => !r.dataset || !r.reportingPeriod).length,
        },
      ];
  function openCreate() {
    setSelected(null);
    setCreating(true);
    setIntake(emptyIntake);
    setError(null);
  }
  function closePanel() {
    setSelected(null);
    setCreating(false);
    setDetail(null);
  }
  function intakeFields(disabled: boolean) {
    return toolSpec.fields.map((field) => (
      <label key={field.id} className={field.type === "textarea" ? "wide" : ""}>
        {field.label}
        {field.requiredAt === "intake" ? (
          " *"
        ) : (
          <small>Required before Ready</small>
        )}
        {field.type === "textarea" ? (
          <textarea
            name={field.id}
            value={intake[field.id]}
            required={field.requiredAt === "intake"}
            maxLength={field.maxLength}
            disabled={disabled}
            onChange={(e) =>
              setIntake((v) => ({ ...v, [field.id]: e.target.value }))
            }
            rows={4}
          />
        ) : (
          <input
            name={field.id}
            value={intake[field.id]}
            required={field.requiredAt === "intake"}
            maxLength={field.maxLength}
            disabled={disabled}
            onChange={(e) =>
              setIntake((v) => ({ ...v, [field.id]: e.target.value }))
            }
          />
        )}
      </label>
    ));
  }
  return (
    <div className="app-shell">
      <aside className="sidebar" inert={creating || Boolean(selected)}>
        <Link className="brand" href="/" aria-label="Loom home">
          <span className="brand-mark" aria-hidden="true">
            L
          </span>
          Loom
        </Link>
        <p className="workspace-label">Analytics workspace</p>
        <nav aria-label="Main">
          <Link className="nav-active" href="/">
            Data requests <span>{desk.requests.length}</span>
          </Link>
        </nav>
        <div className="sidebar-note">
          <strong>One place for the request.</strong>
          <p>Keep the question, context, ownership, and next step together.</p>
        </div>
        <div className="environment">
          <span className={preview ? "dot neutral" : "dot"} />
          {preview ? "Sample preview" : "Exasol Personal"}
        </div>
      </aside>
      <main inert={creating || Boolean(selected)}>
        <header className="topbar">
          <span>
            Workspace <span aria-hidden="true">/</span>{" "}
            <strong>Data requests</strong>
          </span>
          <span className="small">Track 04 · Internal operations</span>
        </header>
        <div className="content">
          {preview && (
            <div className="banner">
              <strong>Read-only sample preview</strong>
              <span>
                These are synthetic examples. Connect Exasol to create and save
                requests. Setup instructions are in the README.
              </span>
            </div>
          )}
          {!preview && (
            <div className="session-bar">
              <span>
                <strong>Local demo</strong> · Synthetic personas only
              </span>
              <label className="inline-label">
                View as{" "}
                <select
                  aria-label="Demo persona"
                  value={member?.userId || ""}
                  disabled={busy}
                  onChange={(e) => void signIn(e.target.value)}
                >
                  <option value="" disabled>
                    Choose persona
                  </option>
                  {personas.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.role}
                    </option>
                  ))}
                </select>
              </label>
              {member && (
                <button
                  className="quiet"
                  disabled={busy}
                  onClick={() => void signOut()}
                >
                  Sign out
                </button>
              )}
            </div>
          )}
          <div className="page-heading">
            <div>
              <p className="eyebrow">
                {own ? "Your work, in view" : "The team’s request desk"}
              </p>
              <h1>{toolSpec.title}</h1>
              <p>Collect the context. Make the next step clear.</p>
            </div>
            <button
              onClick={openCreate}
              disabled={busy || (!preview && !canWrite)}
            >
              + New request
            </button>
          </div>
          {error && (
            <div className="alert" role="alert">
              {error}
              <button
                className="quiet"
                onClick={() => {
                  void refresh();
                  setDetailRevision((v) => v + 1);
                }}
                disabled={busy}
              >
                Refresh saved state
              </button>
            </div>
          )}
          <p className="notice" role="status" aria-live="polite">
            {notice}
          </p>
          {(preview || member) && (
            <>
              <section className="stats" aria-label="Queue summary">
                {stats.map((stat) => (
                  <div key={stat.label}>
                    <span>{stat.label}</span>
                    <strong>{stat.value}</strong>
                  </div>
                ))}
              </section>
              <div className="summary-source">
                {analytics
                  ? `Exasol · ${analytics.queryId} · checked ${new Date(analytics.queriedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`
                  : preview
                    ? "Sample counts · not live SQL results"
                    : "Counts cover the visible list · up to 100 most recently updated requests"}
              </div>
              <section className="queue" aria-label="Request queue">
                <div className="queue-toolbar">
                  <label className="search">
                    <span className="sr-only">Search requests</span>
                    <input
                      type="search"
                      placeholder="Search requests, people, or context…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </label>
                  <label className="inline-label">
                    Status{" "}
                    <select
                      value={status}
                      onChange={(e) => setStatus(e.target.value)}
                    >
                      <option value="all">All statuses</option>
                      {statuses.map((s) => (
                        <option key={s} value={s}>
                          {statusLabels[s]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="secondary"
                    onClick={() => void refresh()}
                    disabled={preview || busy}
                  >
                    Refresh
                  </button>
                </div>
                <div className="table-scroll">
                  <table>
                    <caption className="sr-only">
                      {own ? "Your requests" : "Data request queue"}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Request</th>
                        <th scope="col">Status</th>
                        <th scope="col">Owner</th>
                        <th scope="col">Due</th>
                        {!own && <th scope="col">Priority</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((r) => (
                        <tr
                          key={r.id}
                          className={selected === r.id ? "selected-row" : ""}
                        >
                          <td>
                            <button
                              className="request-link"
                              onClick={() => {
                                setCreating(false);
                                setSelected(r.id);
                                setComment("");
                                setDetailLoading(!preview);
                                setDetail(
                                  preview
                                    ? { request: r, comments: [], activity: [] }
                                    : null,
                                );
                                setIntake(r);
                                setDetailRevision((v) => v + 1);
                              }}
                            >
                              {r.title}
                            </button>
                            <span className="request-meta">
                              {r.requesterName} · Created {date(r.createdAt)}
                            </span>
                          </td>
                          <td>
                            <StatusBadge status={r.status} />
                          </td>
                          <td>
                            {r.ownerName || (
                              <span className="muted">Unassigned</span>
                            )}
                          </td>
                          <td>{date(r.dueAt)}</td>
                          {!own && (
                            <td>
                              <span
                                className={`priority priority-${r.priority}`}
                              >
                                {r.priority}
                              </span>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!filtered.length && (
                  <div className="empty">
                    <h2>
                      {search || status !== "all"
                        ? "No matching requests"
                        : "No requests yet"}
                    </h2>
                    <p>
                      {search || status !== "all"
                        ? "Try a different search or status."
                        : "Create a request to start collecting work in one place."}
                    </p>
                  </div>
                )}
                <div className="table-footer">
                  {filtered.length} shown · {desk.requests.length} loaded
                  <span>
                    {preview
                      ? "Read-only preview"
                      : own
                        ? "Only your requests are visible"
                        : "Saved changes refresh every 15 seconds"}
                  </span>
                </div>
              </section>
              <p className="scope-note">
                The first build supports manual intake and coordination. Agent
                proposals and tool generation are planned.
              </p>
            </>
          )}
          {!preview && !member && (
            <section className="empty login">
              <h2>Open the local demo desk</h2>
              <p>
                Choose a persona above. Owners and operators manage the queue;
                requesters see their own work; viewers have read-only access.
              </p>
            </section>
          )}
        </div>
      </main>
      {(creating || selected) && (
        <div className="panel-backdrop">
          <section
            className="detail-panel"
            aria-labelledby="panel-heading"
            aria-modal="true"
            role="dialog"
            ref={(node) => {
              if (node && !node.contains(document.activeElement)) node.focus();
            }}
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !busy) closePanel();
              if (event.key === "Tab") {
                const nodes = event.currentTarget.querySelectorAll<HTMLElement>(
                  "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]",
                );
                const first = nodes[0],
                  last = nodes[nodes.length - 1];
                if (
                  event.shiftKey &&
                  (document.activeElement === first ||
                    document.activeElement === event.currentTarget)
                ) {
                  event.preventDefault();
                  last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first?.focus();
                }
              }
            }}
          >
            <div className="panel-heading">
              <div>
                <p className="eyebrow">
                  {creating ? "Request intake" : "Request details"}
                </p>
                <h2 id="panel-heading">
                  {creating
                    ? "A clear question starts here"
                    : detail?.request.title || "Loading request…"}
                </h2>
              </div>
              <button
                className="secondary"
                onClick={closePanel}
                disabled={busy}
                aria-label="Close request panel"
              >
                Close
              </button>
            </div>
            {preview && (
              <p className="banner compact">
                Sample preview. Changes cannot be saved until Exasol is
                connected.
              </p>
            )}
            {creating ? (
              <form onSubmit={create}>
                <div className="form-grid">{intakeFields(busy)}</div>
                <p className="hint">
                  * Required at intake. The reporting period and dataset can be
                  clarified later.
                </p>
                <div className="form-actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={closePanel}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                  <button disabled={!canWrite || busy} type="submit">
                    {busy ? "Saving…" : "Create request"}
                  </button>
                </div>
              </form>
            ) : detailLoading ? (
              <p role="status">Loading saved details…</p>
            ) : (
              detail && (
                <>
                  <div className="detail-meta">
                    <StatusBadge status={detail.request.status} />
                    <span>
                      Version {detail.request.version} ·{" "}
                      {detail.request.requesterName}
                    </span>
                    <button
                      className="quiet"
                      disabled={preview || busy}
                      onClick={() => setDetailRevision((v) => v + 1)}
                    >
                      Refresh details
                    </button>
                  </div>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void command({
                        type: "edit_description",
                        values: {
                          title: intake.title,
                          businessQuestion: intake.businessQuestion,
                          reportingPeriod: intake.reportingPeriod,
                          dataset: intake.dataset,
                        },
                      });
                    }}
                  >
                    <div className="form-grid">
                      {intakeFields(!canWrite || busy)}
                    </div>
                    <div className="form-actions">
                      <button
                        type="submit"
                        className="secondary"
                        disabled={!canWrite || busy}
                      >
                        Save description
                      </button>
                    </div>
                  </form>
                  {!own && (
                    <section className="detail-section">
                      <h3>Coordination</h3>
                      <div className="form-grid">
                        <label>
                          Status
                          <select
                            value={detail.request.status}
                            disabled={!operates || busy}
                            onChange={(e) =>
                              void command({
                                type: "set_status",
                                status: e.target.value as Status,
                              })
                            }
                          >
                            {statuses.map((s) => (
                              <option key={s} value={s}>
                                {statusLabels[s]}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Owner
                          <select
                            value={detail.request.ownerId || ""}
                            disabled={!operates || busy}
                            onChange={(e) =>
                              void command({
                                type: "set_owner",
                                ownerId: e.target.value || null,
                              })
                            }
                          >
                            <option value="">Unassigned</option>
                            {desk.members
                              .filter(
                                (m) =>
                                  m.role === "owner" || m.role === "operator",
                              )
                              .map((m) => (
                                <option key={m.userId} value={m.userId}>
                                  {m.name}
                                </option>
                              ))}
                          </select>
                        </label>
                        <label>
                          Priority
                          <select
                            value={detail.request.priority || "normal"}
                            disabled={!operates || busy}
                            onChange={(e) =>
                              void command({
                                type: "set_priority",
                                priority: e.target.value as
                                  "low" | "normal" | "high",
                              })
                            }
                          >
                            {["low", "normal", "high"].map((p) => (
                              <option key={p}>{p}</option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Due date
                          <input
                            type="date"
                            value={detail.request.dueAt || ""}
                            disabled={!operates || busy}
                            onChange={(e) =>
                              void command({
                                type: "set_due_date",
                                dueAt: e.target.value || null,
                              })
                            }
                          />
                        </label>
                      </div>
                    </section>
                  )}
                  <section className="detail-section">
                    <h3>Conversation</h3>
                    {!detail.comments.length && (
                      <p className="muted">No comments yet.</p>
                    )}
                    {detail.comments.map((c) => (
                      <article className="comment" key={c.id}>
                        <strong>{c.authorName}</strong>
                        <small>
                          {date(c.createdAt)} ·{" "}
                          {c.visibility === "internal"
                            ? "Internal"
                            : "Visible to requester"}
                        </small>
                        <p>{c.body}</p>
                      </article>
                    ))}
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        await command({
                          type: "add_comment",
                          body: comment,
                          visibility: own ? "requester_visible" : visibility,
                        });
                      }}
                    >
                      <label>
                        Add a comment
                        <textarea
                          rows={3}
                          value={comment}
                          maxLength={4000}
                          required
                          disabled={!canWrite || busy}
                          onChange={(e) => setComment(e.target.value)}
                        />
                      </label>
                      <div className="form-actions">
                        {!own && (
                          <label className="inline-label">
                            Visibility
                            <select
                              value={visibility}
                              disabled={!canWrite || busy}
                              onChange={(e) =>
                                setVisibility(
                                  e.target.value as typeof visibility,
                                )
                              }
                            >
                              <option value="requester_visible">
                                Visible to requester
                              </option>
                              <option value="internal">Internal team</option>
                            </select>
                          </label>
                        )}
                        <button disabled={!canWrite || busy || !comment.trim()}>
                          Add comment
                        </button>
                      </div>
                    </form>
                  </section>
                  <section className="detail-section">
                    <h3>Activity</h3>
                    {!detail.activity.length && (
                      <p className="muted">
                        {preview
                          ? "Sample history is not connected."
                          : "No activity recorded yet."}
                      </p>
                    )}
                    <ol className="activity">
                      {detail.activity.map((a) => (
                        <li key={a.id}>
                          <span>
                            {a.actorName} · {a.action.replaceAll("_", " ")}
                          </span>
                          <small>
                            v{a.version} · {date(a.createdAt)}
                          </small>
                        </li>
                      ))}
                    </ol>
                  </section>
                </>
              )
            )}
            {error && (
              <p className="alert" role="alert">
                {error}
              </p>
            )}
            <p role="status" className="notice">
              {busy ? "Saving…" : notice}
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
