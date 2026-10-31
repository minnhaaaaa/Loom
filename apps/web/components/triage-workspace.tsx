"use client";
import { LoomSelect } from "./ui/loom-select";
import { workspaceFetch } from "./workspace-fetch";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  toolSpec,
  type KnowledgeEntry,
  type KnowledgeInput,
  type Membership,
  type PublicRequest,
  type RunDetails,
  type TriageProposal,
  type TriageRun,
  type ToolSpec,
  type PreferredAgent,
} from "@loom/contracts";
import { ConsoleChrome } from "./ui/civitas";
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await workspaceFetch(path, {
    ...options,
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(
      new Error(
        data.error?.message ||
          "Operation could not be confirmed. Retry the unchanged action.",
      ),
      { status: response.status },
    );
  return data;
}
function emptyKnowledge(): KnowledgeInput {
  return {
    title: "",
    kind: "procedure",
    content: "",
    dataset: "",
    ownerId: null,
    effectiveFrom: new Date().toISOString().slice(0, 10),
    effectiveUntil: null,
    supersedesId: null,
  };
}
export function TriageWorkspace({
  owner,
  requests,
  members,
  onApplied,
  spec = toolSpec,
  preferredAgent = "loom",
}: {
  owner: boolean;
  requests: PublicRequest[];
  members: Membership[];
  onApplied: () => Promise<void>;
  spec?: ToolSpec;
  preferredAgent?: PreferredAgent;
}) {
  const externalAgent = ["codex", "claude-code", "other"].includes(
    preferredAgent,
  );
  const externalAgentLabel =
    preferredAgent === "codex"
      ? "Codex"
      : preferredAgent === "claude-code"
        ? "Claude Code"
        : "your external agent";
  const [knowledge, setKnowledge] = useState<KnowledgeEntry[]>([]),
    [hasMore, setHasMore] = useState(false),
    [runs, setRuns] = useState<TriageRun[]>([]),
    [detail, setDetail] = useState<RunDetails | null>(null);
  const [values, setValues] = useState<KnowledgeInput>(emptyKnowledge),
    [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const [evidence, setEvidence] = useState<KnowledgeEntry | null>(null),
    [reviewed, setReviewed] = useState<string[]>([]);
  const [instructions, setInstructions] = useState("");
  const [learning, setLearning] = useState<{
    proposal: TriageProposal;
    title: string;
    body: string;
    rationale: string;
  } | null>(null);
  const [inferring, setInferring] = useState(false);
  const [configuration, setConfiguration] = useState<{
    configured: boolean;
    model: string | null;
    message: string;
  }>({
    configured: false,
    model: null,
    message: "Loading model configuration.",
  });
  const pending = useRef<{ payload: string; id: string } | null>(null);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const [sources, recent] = await Promise.all([
      api<{ entries: KnowledgeEntry[]; hasMore: boolean }>("/api/knowledge", {
        signal,
      }),
      api<{
        runs: TriageRun[];
        configuration: {
          configured: boolean;
          model: string | null;
          message: string;
        };
      }>("/api/runs", { signal }),
    ]);
    if (signal?.aborted) return;
    setKnowledge(sources.entries);
    setHasMore(sources.hasMore);
    setRuns(recent.runs);
    setConfiguration(recent.configuration);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void refresh(controller.signal).catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    }, 0);
    const polling = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void refresh(controller.signal).catch((cause) => {
        if (controller.signal.aborted) return;
        if ([401, 403].includes(Number(cause.status))) {
          setKnowledge([]);
          setRuns([]);
          setDetail(null);
          setEvidence(null);
          setLearning(null);
        }
        setError(cause.message);
      });
    }, 10000);
    return () => {
      clearTimeout(timer);
      clearInterval(polling);
      controller.abort();
    };
  }, [refresh]);
  async function work(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await task();
    } catch (error) {
      if ([401, 403].includes((error as { status: number }).status)) {
        setKnowledge([]);
        setRuns([]);
        setDetail(null);
        setEvidence(null);
        setReviewed([]);
        setLearning(null);
      }
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function command<T>(path: string, body: object): Promise<T> {
    const payload = JSON.stringify({ path, body });
    if (pending.current?.payload !== payload)
      pending.current = { payload, id: crypto.randomUUID() };
    const result = await api<T>(path, {
      method: "POST",
      body: JSON.stringify({ ...body, commandId: pending.current.id }),
    });
    pending.current = null;
    return result;
  }
  async function draft(event: FormEvent) {
    event.preventDefault();
    await work(async () => {
      await command("/api/knowledge", { values });
      setValues(emptyKnowledge());
      await refresh();
      setMessage(
        "Knowledge draft saved. An owner must approve it before triage can use it.",
      );
    });
  }
  async function knowledgeAction(
    entry: KnowledgeEntry,
    action: "approve" | "retire",
  ) {
    await work(async () => {
      await command(`/api/knowledge/${entry.id}`, {
        expectedVersion: entry.version,
        action,
      });
      await refresh();
      setMessage(`Knowledge ${action === "approve" ? "approved" : "retired"}.`);
    });
  }
  const selection = selected.filter((id) =>
    requests.some((request) => request.id === id),
  );
  async function start() {
    await work(async () => {
      const run = await command<TriageRun>("/api/runs", {
        requestIds: selection,
        instructions,
      });
      setDetail(await api<RunDetails>(`/api/runs/${run.id}`));
      setReviewed([]);
      await refresh();
      setMessage(
        "Run saved. Process one request at a time; you can reload and resume its checkpoint.",
      );
    });
  }
  async function loadRun(id: string) {
    await work(async () => {
      setDetail(await api<RunDetails>(`/api/runs/${id}`));
      setReviewed([]);
      await refresh();
      const runPanel = document.querySelector<HTMLDetailsElement>(
        "#agent-workspace .agent-run-details",
      );
      if (runPanel) {
        runPanel.open = true;
        runPanel.scrollIntoView({ block: "start" });
        runPanel
          .querySelector<HTMLElement>("summary")
          ?.focus({ preventScroll: true });
      }
    });
  }
  async function advance(action: "advance" | "cancel") {
    if (!detail) return;
    setInferring(action === "advance");
    try {
      await work(async () => {
        setDetail(
          await command<RunDetails>(`/api/runs/${detail.run.id}`, {
            expectedVersion: detail.run.version,
            action,
          }),
        );
        setReviewed([]);
        await refresh();
        setMessage(
          action === "cancel"
            ? "Run cancelled. In-flight output cannot be applied."
            : "Model checkpoint saved. Review its proposed changes before applying.",
        );
      });
    } finally {
      setInferring(false);
    }
  }
  async function cancelInFlight() {
    if (!detail) return;
    try {
      const latest = await api<RunDetails>(`/api/runs/${detail.run.id}`);
      setDetail(
        await api<RunDetails>(`/api/runs/${detail.run.id}`, {
          method: "POST",
          body: JSON.stringify({
            commandId: crypto.randomUUID(),
            expectedVersion: latest.run.version,
            action: "cancel",
          }),
        }),
      );
      setMessage("Run cancelled. In-flight model output cannot be applied.");
    } catch (error) {
      setError((error as Error).message);
    }
  }
  async function review(
    proposal: TriageProposal,
    action: "approve" | "reject",
  ) {
    if (!detail) return;
    await work(async () => {
      await command(`/api/proposals/${proposal.content.id}`, {
        hash: proposal.hash,
        action,
      });
      setDetail(await api<RunDetails>(`/api/runs/${detail.run.id}`));
      setReviewed([]);
      await onApplied();
      setMessage(
        action === "approve"
          ? "Reviewed changes saved atomically."
          : "Proposal rejected. No request changes applied.",
      );
    });
  }
  const name = (id: string | null) =>
    members.find((m) => m.userId === id)?.name || id || "Unassigned";

  async function saveLearning(event: FormEvent) {
    event.preventDefault();
    if (!learning) return;
    await work(async () => {
      await command<KnowledgeEntry>(
        `/api/proposals/${learning.proposal.content.id}/knowledge`,
        {
          hash: learning.proposal.hash,
          title: learning.title,
          body: learning.body,
          rationale: learning.rationale,
        },
      );
      setLearning(null);
      await refresh();
      const knowledgePanel = document.getElementById("agent-knowledge");
      if (knowledgePanel instanceof HTMLDetailsElement)
        knowledgePanel.open = true;
      setMessage(
        "Decision saved as draft guidance with its source and your explanation. An owner must approve it before the agent can reuse it.",
      );
    });
  }

  function changedValues(proposal: TriageProposal) {
    const before = proposal.content.before,
      after = proposal.content.after;
    const rows = spec.fields.map((field) => ({
      id: `field:${field.id}`,
      label: field.label,
      before: field.id.startsWith("custom_")
        ? before.customValues?.[field.id] || ""
        : String(before[field.id as keyof typeof before] || ""),
      after: field.id.startsWith("custom_")
        ? after.customValues?.[field.id] || ""
        : String(after[field.id as keyof typeof after] || ""),
    }));
    rows.push(
      {
        id: "system:status",
        label: "Status",
        before: spec.statusLabels[before.status],
        after: spec.statusLabels[after.status],
      },
      {
        id: "system:owner",
        label: "Owner",
        before: name(before.ownerId),
        after: name(after.ownerId),
      },
      {
        id: "system:priority",
        label: "Priority",
        before: before.priority,
        after: after.priority,
      },
      {
        id: "system:dueAt",
        label: "Due date",
        before: before.dueAt || "",
        after: after.dueAt || "",
      },
    );
    return rows.filter((row) => row.before !== row.after);
  }
  return (
    <section
      id="agent-workspace"
      className="triage-workspace triage-console"
      aria-label="Triage and team knowledge"
    >
      <ConsoleChrome
        label="Loom / triage and knowledge"
        status={
          inferring
            ? "Model running"
            : busy
              ? "Working…"
              : externalAgent
                ? "External agent workspace"
                : !configuration.configured
                  ? "Model unavailable"
                  : detail
                    ? detail.run.status.replaceAll("_", " ")
                    : "Ready"
        }
      />
      <div className="triage-console-body">
        <h2>Work alongside your agent</h2>
        <p>
          Work through the queue with an agent. Your team’s knowledge guides its
          suggestions; you review every change before it is saved.
        </p>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        <p>
          {externalAgent
            ? `${externalAgentLabel} connects through MCP. Ask it to inspect selected records and submit a proposal; review its saved changes here.`
            : configuration.configured
              ? `OpenRouter · ${configuration.model}`
              : configuration.message}
        </p>
        <button
          className="secondary"
          disabled={busy}
          onClick={() =>
            void work(async () => {
              await refresh();
              if (detail)
                setDetail(await api<RunDetails>(`/api/runs/${detail.run.id}`));
            })
          }
        >
          {externalAgent
            ? "Refresh agent proposals"
            : "Refresh model and saved state"}
        </button>
        <p className="notice" role="status" aria-live="polite">
          {busy ? "Working…" : message}
        </p>
        <details id="agent-knowledge">
          <summary>Team knowledge</summary>
          <p>
            Operators can draft. Only owners can approve, supersede, or retire
            guidance. The agent retrieves relevant approved sources as reference
            material. A reviewed decision becomes reusable only after separate
            owner approval.
          </p>
          <form onSubmit={(event) => void draft(event)}>
            <div className="triage-form">
              <label>
                Knowledge title
                <input
                  required
                  maxLength={160}
                  disabled={busy}
                  value={values.title}
                  onChange={(event) =>
                    setValues({ ...values, title: event.target.value })
                  }
                />
              </label>
              <label>
                Knowledge kind
                <LoomSelect
                  disabled={busy}
                  value={values.kind}
                  onChange={(event) =>
                    setValues({
                      ...values,
                      kind: event.target.value as KnowledgeInput["kind"],
                      dataset: "",
                      ownerId: null,
                    })
                  }
                >
                  <option value="routing">Routing guidance</option>
                  <option value="procedure">Procedure</option>
                  <option value="glossary">Glossary</option>
                </LoomSelect>
              </label>
              {values.kind === "routing" && (
                <>
                  <label>
                    Dataset context (optional)
                    <input
                      maxLength={200}
                      disabled={busy}
                      value={values.dataset}
                      onChange={(event) =>
                        setValues({ ...values, dataset: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Owner context (optional)
                    <LoomSelect
                      disabled={busy}
                      value={values.ownerId || ""}
                      onChange={(event) =>
                        setValues({
                          ...values,
                          ownerId: event.target.value || null,
                        })
                      }
                    >
                      <option value="">Choose owner</option>
                      {members
                        .filter((m) => ["owner", "operator"].includes(m.role))
                        .map((m) => (
                          <option key={m.userId} value={m.userId}>
                            {m.name}
                          </option>
                        ))}
                    </LoomSelect>
                  </label>
                </>
              )}
              <label>
                Effective from (UTC)
                <input
                  type="date"
                  required
                  disabled={busy}
                  value={values.effectiveFrom}
                  onChange={(event) =>
                    setValues({ ...values, effectiveFrom: event.target.value })
                  }
                />
              </label>
              <label>
                Effective until (UTC)
                <input
                  type="date"
                  disabled={busy}
                  value={values.effectiveUntil || ""}
                  onChange={(event) =>
                    setValues({
                      ...values,
                      effectiveUntil: event.target.value || null,
                    })
                  }
                />
              </label>
            </div>
            <label>
              Knowledge content
              <textarea
                required
                rows={3}
                maxLength={4000}
                disabled={busy}
                value={values.content}
                onChange={(event) =>
                  setValues({ ...values, content: event.target.value })
                }
              />
            </label>
            {values.supersedesId && (
              <p>
                Replacement draft for {values.supersedesId}. The approved source
                stays active until this replacement is approved.
              </p>
            )}
            <button disabled={busy} type="submit">
              Save knowledge draft
            </button>{" "}
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setValues(emptyKnowledge())}
            >
              Clear draft form
            </button>
          </form>
          <p>
            Showing the latest {knowledge.length} entries
            {hasMore
              ? " (more entries exist; full knowledge pagination is pending)"
              : ""}
            .
          </p>
          {knowledge.map((entry) => (
            <article key={entry.id} className="knowledge-entry">
              <h3>{entry.title}</h3>
              <p>
                {entry.kind} · {entry.state} · v{entry.version} ·{" "}
                {entry.effectiveFrom} to {entry.effectiveUntil || "no end date"}
              </p>
              {(entry.dataset || entry.ownerId) && (
                <p>
                  Context: {entry.dataset || "Any"}
                  {entry.ownerId
                    ? ` · owner context: ${name(entry.ownerId)}`
                    : ""}
                </p>
              )}
              <p className="source-text">{entry.content}</p>
              {entry.provenance && (
                <details className="knowledge-provenance">
                  <summary>Why this guidance was saved</summary>
                  <p>{entry.provenance.rationale}</p>
                  <p>
                    Recorded by {name(entry.provenance.recordedBy)} from a
                    decision reviewed by {name(entry.provenance.reviewedBy)}.
                  </p>
                  <p className="memory-identifier">
                    Proposal {entry.provenance.proposalId} · record{" "}
                    {entry.provenance.requestId} · v
                    {entry.provenance.requestVersion}
                  </p>
                  <button
                    className="quiet"
                    disabled={busy}
                    onClick={() => void loadRun(entry.provenance!.runId)}
                  >
                    Open source decision
                  </button>
                </details>
              )}
              {entry.supersedesId && (
                <p>Replaces entry {entry.supersedesId} on approval.</p>
              )}
              {owner && entry.state === "draft" && (
                <button
                  disabled={busy}
                  onClick={() => void knowledgeAction(entry, "approve")}
                >
                  Approve knowledge: {entry.title}
                </button>
              )}{" "}
              {owner && ["draft", "approved"].includes(entry.state) && (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => void knowledgeAction(entry, "retire")}
                >
                  Retire knowledge: {entry.title}
                </button>
              )}{" "}
              {entry.state === "approved" && (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    setValues({
                      title: entry.title,
                      kind: entry.kind,
                      content: entry.content,
                      dataset: entry.dataset,
                      ownerId: entry.ownerId,
                      effectiveFrom: entry.effectiveFrom,
                      effectiveUntil: entry.effectiveUntil,
                      supersedesId: entry.id,
                    });
                    setMessage(
                      "Edit the copied draft, then save. Only owner approval replaces the current source.",
                    );
                  }}
                >
                  Draft replacement: {entry.title}
                </button>
              )}
            </article>
          ))}
        </details>
        <details className="agent-run-details">
          <summary>
            {externalAgent
              ? "Agent proposals and human review"
              : "Run triage and review proposals"}
          </summary>
          {externalAgent && (
            <p className="banner compact">
              Your agent runs in its own client. Use its Loom tools to read the
              workspace and propose changes. New proposals appear in recent runs
              below. The built-in triage controls remain available when a server
              model is configured.
            </p>
          )}
          <p>
            Choose up to 20 requests from the current queue page. Runs expire
            after 30 minutes. Each advance saves one request checkpoint in
            Exasol; saved runs survive a browser reload or server restart.
          </p>
          <div
            className="agent-task-starters"
            role="group"
            aria-label="Suggested agent tasks"
          >
            {[
              "Check the selected records for missing information. Use the tool’s field labels and approved procedures to propose clear follow-up comments.",
              "Suggest owners for the selected records using approved routing guidance. Explain your evidence and leave ownership unchanged when guidance is missing.",
              "Review progress and due dates for the selected records. Summarize what needs attention and propose next steps supported by approved guidance.",
            ].map((task, index) => (
              <button
                key={task}
                className="secondary"
                disabled={busy}
                onClick={() => setInstructions(task)}
              >
                {
                  ["Find missing details", "Suggest owners", "Review progress"][
                    index
                  ]
                }
              </button>
            ))}
          </div>
          <div className="triage-selection">
            {requests.map((request) => (
              <label key={request.id}>
                <input
                  type="checkbox"
                  disabled={
                    busy ||
                    (!selection.includes(request.id) && selection.length >= 20)
                  }
                  checked={selection.includes(request.id)}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? [...selection, request.id]
                        : selection.filter((id) => id !== request.id),
                    )
                  }
                />{" "}
                {request.title}
              </label>
            ))}
          </div>
          <label>
            Instructions for the model
            <textarea
              aria-label="Instructions for the model"
              required
              maxLength={4000}
              rows={3}
              value={instructions}
              disabled={busy}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </label>
          <button
            disabled={
              busy ||
              !configuration.configured ||
              !selection.length ||
              !instructions.trim()
            }
            onClick={() => void start()}
          >
            Start triage ({selection.length})
          </button>
          <label>
            Recent runs (workspace latest 10)
            <LoomSelect
              disabled={busy}
              value={detail?.run.id || ""}
              onChange={(event) => void loadRun(event.target.value)}
            >
              <option value="" disabled>
                Choose saved run
              </option>
              {runs.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.status} · {run.checkpoint}/{run.requestIds.length} ·{" "}
                  {new Date(run.createdAt).toLocaleString()}
                </option>
              ))}
            </LoomSelect>
          </label>
          {detail && (
            <div className="run-review">
              <h3>Run checkpoint</h3>
              <p>
                {detail.run.status} · {detail.run.checkpoint}/
                {detail.run.requestIds.length} processed · v{detail.run.version}{" "}
                · expires {new Date(detail.run.expiresAt).toLocaleTimeString()}
              </p>
              <p>
                {detail.run.model || "Legacy engine"} ·{" "}
                {detail.run.instructions || "Historical run — read-only"}
              </p>
              {detail.run.engine === "openrouter-v1" &&
                ["queued", "running"].includes(detail.run.status) && (
                  <>
                    <button
                      disabled={busy}
                      onClick={() => void advance("advance")}
                    >
                      Process next request
                    </button>{" "}
                    <button
                      className="secondary"
                      disabled={busy && !inferring}
                      onClick={() =>
                        void (inferring ? cancelInFlight() : advance("cancel"))
                      }
                    >
                      Cancel triage run
                    </button>
                  </>
                )}{" "}
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void loadRun(detail.run.id)}
              >
                Refresh saved run
              </button>
              {detail.steps.map((step) => (
                <p key={step.index}>
                  Request {step.index + 1}: {step.summary}{" "}
                  {step.uncertainty.join(" ")}
                </p>
              ))}
              {detail.proposals.map((proposal) => (
                <article className="proposal-review" key={proposal.content.id}>
                  <h3>Review: {proposal.content.before.title}</h3>
                  <p>
                    {proposal.state} · request v
                    {proposal.content.expectedVersion} · proposal revision{" "}
                    {proposal.content.revision}
                  </p>
                  <p>{proposal.content.reasons.join(" ")}</p>
                  {proposal.content.uncertainty.map((reason) => (
                    <p key={reason}>{reason}</p>
                  ))}
                  <p>
                    {proposal.content.engine === "external-mcp-v1"
                      ? "Submitted by"
                      : "Generated by"}{" "}
                    {proposal.content.inference?.actualModel ||
                      "historical engine"}{" "}
                    ·{" "}
                    {proposal.content.inference?.completionTokens ?? "unknown"}{" "}
                    output tokens
                  </p>
                  <details open>
                    <summary>Exact model-proposed actions</summary>
                    <pre className="source-text">
                      {JSON.stringify(proposal.content.commands, null, 2)}
                    </pre>
                  </details>
                  <dl className="proposal-changes">
                    {changedValues(proposal).map((row) => (
                      <div key={row.id}>
                        <dt>{row.label}</dt>
                        <dd>
                          <span>{row.before || "Empty"}</span>
                          <span aria-hidden="true"> → </span>
                          <strong>{row.after || "Empty"}</strong>
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {proposal.content.commands
                    .filter((command) => command.type === "add_comment")
                    .map(
                      (command, index) =>
                        command.type === "add_comment" && (
                          <div key={index}>
                            <strong>
                              {command.visibility === "internal"
                                ? "Internal comment to add"
                                : "Requester-visible comment to add"}
                            </strong>
                            <p className="source-text">{command.body}</p>
                          </div>
                        ),
                    )}
                  <p>
                    Evidence:{" "}
                    {proposal.content.evidence.length
                      ? proposal.content.evidence.map((source) => (
                          <button
                            key={source.id}
                            className="quiet"
                            disabled={busy}
                            onClick={() =>
                              void work(async () => {
                                setEvidence(
                                  await api<KnowledgeEntry>(
                                    `/api/knowledge/${source.id}`,
                                  ),
                                );
                              })
                            }
                          >
                            {source.title} · v{source.version}
                          </button>
                        ))
                      : "The model cited no approved source. Review its reasoning and uncertainty."}
                  </p>
                  <p className="small">
                    Review hash: <code>{proposal.hash}</code>
                  </p>
                  {proposal.state === "pending" && (
                    <>
                      <label>
                        <input
                          type="checkbox"
                          disabled={busy}
                          checked={reviewed.includes(proposal.hash)}
                          onChange={(event) =>
                            setReviewed(
                              event.target.checked
                                ? [...reviewed, proposal.hash]
                                : reviewed.filter(
                                    (hash) => hash !== proposal.hash,
                                  ),
                            )
                          }
                        />{" "}
                        I reviewed these exact changes and evidence.
                      </label>
                      <button
                        disabled={
                          busy ||
                          !["openrouter-v1", "external-mcp-v1"].includes(
                            detail.run.engine,
                          ) ||
                          detail.run.status !== "completed" ||
                          !reviewed.includes(proposal.hash)
                        }
                        onClick={() => void review(proposal, "approve")}
                      >
                        Approve changes: {proposal.content.before.title}
                      </button>{" "}
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => void review(proposal, "reject")}
                      >
                        Reject proposal: {proposal.content.before.title}
                      </button>
                    </>
                  )}
                  {proposal.state === "applied" && (
                    <div className="decision-learning">
                      <p>
                        A useful decision can become reusable guidance. Write
                        when it applies and why; an owner reviews it before
                        future runs use it.
                      </p>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          setLearning({
                            proposal,
                            title: "",
                            body: "",
                            rationale: "",
                          })
                        }
                      >
                        Draft guidance from this decision
                      </button>
                      {learning?.proposal.content.id ===
                        proposal.content.id && (
                        <form onSubmit={(event) => void saveLearning(event)}>
                          <label>
                            Guidance title
                            <input
                              required
                              maxLength={160}
                              disabled={busy}
                              value={learning.title}
                              onChange={(event) =>
                                setLearning({
                                  ...learning,
                                  title: event.target.value,
                                })
                              }
                            />
                          </label>
                          <label>
                            Reusable guidance
                            <textarea
                              required
                              maxLength={4000}
                              rows={4}
                              disabled={busy}
                              value={learning.body}
                              placeholder="Describe the rule and the situations where it applies."
                              onChange={(event) =>
                                setLearning({
                                  ...learning,
                                  body: event.target.value,
                                })
                              }
                            />
                          </label>
                          <label>
                            Why should the team reuse this decision?
                            <textarea
                              required
                              maxLength={2000}
                              rows={3}
                              disabled={busy}
                              value={learning.rationale}
                              onChange={(event) =>
                                setLearning({
                                  ...learning,
                                  rationale: event.target.value,
                                })
                              }
                            />
                          </label>
                          <button
                            disabled={
                              busy ||
                              !learning.title.trim() ||
                              !learning.body.trim() ||
                              !learning.rationale.trim()
                            }
                          >
                            Save guidance draft
                          </button>{" "}
                          <button
                            type="button"
                            className="quiet"
                            disabled={busy}
                            onClick={() => setLearning(null)}
                          >
                            Cancel guidance draft
                          </button>
                        </form>
                      )}
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </details>
        {evidence && (
          <aside aria-label="Knowledge evidence" className="knowledge-entry">
            <h3>Source: {evidence.title}</h3>
            <p>
              {evidence.state} · current v{evidence.version} ·{" "}
              {evidence.effectiveFrom} to{" "}
              {evidence.effectiveUntil || "no end date"}
            </p>
            <p className="source-text">{evidence.content}</p>
            <button className="secondary" onClick={() => setEvidence(null)}>
              Close evidence
            </button>
          </aside>
        )}
      </div>
    </section>
  );
}
