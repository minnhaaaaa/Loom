"use client";
import { LoomSelect } from "./ui/loom-select";
import { workspaceFetch } from "./workspace-fetch";

import { useEffect, useRef, useState } from "react";
import { ToolFields, ToolTable } from "./tool-renderer";
import {
  processTemplates,
  processTemplateDraft,
  statuses,
  toolCompatibility,
  toolSpecChanges,
  toolSpecSchema,
  type Membership,
  type PublishedTool,
  type ToolDraft,
  type ToolField,
  type ToolSpec,
  type ToolWorkspace,
  type ProcessTemplateId,
} from "@loom/contracts";

const columnLabels: Record<string, string> = {
  title: "Request title",
  businessQuestion: "Business question",
  reportingPeriod: "Reporting period",
  dataset: "Dataset",
  requesterName: "Requester",
  ownerName: "Owner",
  status: "Status",
  dueAt: "Due date",
  priority: "Priority",
  createdAt: "Created date",
};
const metricLabels = {
  open: "Open requests",
  overdue: "Overdue",
  unassigned: "Unassigned",
  incomplete: "Missing requirements",
} as const;
const copy = <T,>(value: T): T => structuredClone(value);
const formatDate = (date: string | null) =>
  date ? new Date(date).toLocaleString("en-IN") : "Built-in template";
function retryDelay(seconds: number) {
  if (seconds >= 3600)
    return `${Math.ceil(seconds / 3600)} ${seconds > 3600 ? "hours" : "hour"}`;
  if (seconds >= 60) return `${Math.ceil(seconds / 60)} minutes`;
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

class BuilderError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string = "UNKNOWN",
    public retryAfterSeconds?: number,
    public retryable?: boolean,
  ) {
    super(message);
  }
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await workspaceFetch(path, {
    ...options,
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
  });
  const body = await response.json();
  if (!response.ok) {
    const rawRetryAfter =
      body.error?.retryAfterSeconds ?? response.headers.get("Retry-After");
    const seconds = rawRetryAfter === null ? NaN : Number(rawRetryAfter);
    throw new BuilderError(
      body.error?.message ||
        "The change could not be confirmed. Retry the unchanged action.",
      response.status,
      body.error?.code || "UNKNOWN",
      Number.isFinite(seconds) && seconds > 0
        ? Math.min(86400, Math.max(1, Math.ceil(seconds)))
        : undefined,
      typeof body.error?.retryable === "boolean"
        ? body.error.retryable
        : undefined,
    );
  }
  return body as T;
}

export type ToolBuilderProps = {
  published: PublishedTool;
  membership: Membership | null;
  preview: boolean;
  onPublished: (tool: PublishedTool) => void;
  onPreview?: (spec: ToolSpec | null) => void;
};

export function ToolBuilder({
  published,
  membership,
  preview,
  onPublished,
  onPreview,
}: ToolBuilderProps) {
  const [spec, setSpec] = useState<ToolSpec>(() => copy(published.spec));
  const [baseRevision, setBaseRevision] = useState(published.revision);
  const [instructions, setInstructions] = useState("");
  const [workspace, setWorkspace] = useState<ToolWorkspace | null>(null);
  const [savedDraft, setSavedDraft] = useState<ToolDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [assumptions, setAssumptions] = useState<string[]>([]);
  const [unsupported, setUnsupported] = useState<string[]>([]);
  const [fieldName, setFieldName] = useState("");
  const [fieldType, setFieldType] = useState<"text" | "textarea">("text");
  const [previewing, setPreviewing] = useState(false);
  const [open, setOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const failureRef = useRef<BuilderError | null>(null);
  const pending = useRef<{ payload: string; id: string } | null>(null);
  const pendingGeneration = useRef<{ payload: string; id: string } | null>(
    null,
  );
  const [generationFailure, setGenerationFailure] =
    useState<BuilderError | null>(null);
  const [generationRetry, setGenerationRetry] = useState<{
    until: number;
    remaining: number;
  } | null>(null);
  const owner = membership?.role === "owner";
  const canSave = owner && !preview;
  const current =
    workspace && workspace.published.revision > published.revision
      ? workspace.published
      : published;
  const parsed = toolSpecSchema.safeParse(spec);
  const compatibility = parsed.success
    ? toolCompatibility(current.spec, parsed.data)
    : { errors: [], warnings: [] };
  const validationErrors = parsed.success
    ? []
    : parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "Tool"}: ${issue.message}`,
      );
  const errors = [...validationErrors, ...compatibility.errors];
  const changes = parsed.success
    ? toolSpecChanges(current.spec, parsed.data)
    : [];
  const stale = baseRevision !== current.revision;
  const terminalGeneration = Boolean(
    generationFailure &&
    ["GENERATION_RETRY_LIMIT", "MODEL_CONFIGURATION_CHANGED"].includes(
      generationFailure.code,
    ),
  );
  const retryBlocked = Boolean(generationRetry?.remaining);
  const queue = spec.views.find((view) => view.component === "request-table");
  const filters = spec.views.find(
    (view) => view.component === "request-filters",
  );
  const summary = spec.views.find(
    (view) => view.component === "request-summary",
  );
  const columns = [
    ...Object.keys(columnLabels),
    ...spec.fields
      .filter((field) => field.id.startsWith("custom_"))
      .map((field) => field.id),
  ];
  const labelFor = (id: string) =>
    spec.fields.find((field) => field.id === id)?.label ||
    columnLabels[id] ||
    id;
  const sampleTemplate = processTemplates.find((template) =>
    template.spec.fields
      .filter((field) => !field.id.startsWith("custom_"))
      .every(
        (field) =>
          spec.fields.find((candidate) => candidate.id === field.id)?.label ===
          field.label,
      ),
  );

  useEffect(() => {
    failureRef.current = generationFailure;
  }, [generationFailure]);
  useEffect(() => {
    if (preview || !owner) return;
    const controller = new AbortController();
    let running = false;
    const load = async () => {
      if (running) return;
      running = true;
      try {
        const result = await api<ToolWorkspace>("/api/tool", {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setWorkspace(result);
        const failure = failureRef.current;
        if (
          aiOpen &&
          result.configuration.configured &&
          failure?.retryable === false &&
          !["GENERATION_RETRY_LIMIT", "MODEL_CONFIGURATION_CHANGED"].includes(
            failure.code,
          )
        ) {
          setGenerationFailure(null);
          setError((currentError) =>
            currentError === failure.message ? "" : currentError,
          );
        }
      } catch (reason) {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not load desk settings.",
          );
      } finally {
        running = false;
      }
    };
    void load();
    const onFocus = () => {
      if (aiOpen) void load();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      controller.abort();
      window.removeEventListener("focus", onFocus);
    };
  }, [preview, owner, membership?.userId, aiOpen]);

  const retryUntil = generationRetry?.until;
  useEffect(() => {
    if (!retryUntil) return;
    const timer = setInterval(() => {
      const remaining = Math.max(
        0,
        Math.ceil((retryUntil - Date.now()) / 1000),
      );
      setGenerationRetry(remaining ? { until: retryUntil, remaining } : null);
    }, 1000);
    return () => clearInterval(timer);
  }, [retryUntil]);

  function edit(next: ToolSpec) {
    setSpec(next);
    setSavedDraft(null);
    setMessage("");
    setGenerationFailure(null);
    if (previewing) {
      const result = toolSpecSchema.safeParse(next);
      onPreview?.(result.success ? result.data : null);
    }
  }

  function adoptSpec(next: ToolSpec, source: string) {
    edit(copy(next));
    setBaseRevision(current.revision);
    setAssumptions([]);
    setUnsupported([]);
    setError("");
    setMessage(`${source} copied into your draft. Review it before saving.`);
  }

  function chooseTemplate(id: ProcessTemplateId) {
    try {
      const template = processTemplates.find(
        (candidate) => candidate.id === id,
      )!;
      const next = processTemplateDraft(spec, id);
      adoptSpec(next, `${template.label} template`);
      setInstructions(template.prompt);
    } catch {
      setError(
        "This template would exceed the supported field or column limit. Your draft is preserved. Customize it directly or use a separate workspace for this process.",
      );
    }
  }

  function editField(id: string, values: Partial<ToolField>) {
    edit({
      ...spec,
      fields: spec.fields.map((field) =>
        field.id === id ? { ...field, ...values } : field,
      ),
    });
  }

  function addField() {
    const label = fieldName.trim();
    if (!label) return;
    const slug = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 24);
    const stem = /^[a-z]/.test(slug) ? slug : `field_${slug || "new"}`;
    let key = `custom_${stem}`;
    let suffix = 2;
    while (spec.fields.some((field) => field.id === key))
      key = `custom_${stem}_${suffix++}`;
    edit({
      ...spec,
      fields: [
        ...spec.fields,
        {
          id: key as ToolField["id"],
          label,
          type: fieldType,
          requiredAt: "optional",
          maxLength: fieldType === "textarea" ? 2000 : 200,
          visible: true,
        },
      ],
    });
    setFieldName("");
  }

  async function command<T>(path: string, values: object): Promise<T> {
    const payload = JSON.stringify({ path, values });
    const commandRef =
      path === "/api/tool/generate" ? pendingGeneration : pending;
    if (commandRef.current?.payload !== payload)
      commandRef.current = { payload, id: crypto.randomUUID() };
    const result = await api<T>(path, {
      method: "POST",
      body: JSON.stringify({ ...values, commandId: commandRef.current.id }),
    });
    commandRef.current = null;
    return result;
  }

  async function work(task: () => Promise<unknown>, generation = false) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    if (generation) setGenerationFailure(null);
    try {
      await task();
    } catch (reason) {
      if (generation && pendingGeneration.current) {
        const failure =
          reason instanceof BuilderError
            ? reason
            : new BuilderError(
                reason instanceof Error
                  ? reason.message
                  : "Generation could not be confirmed.",
                0,
              );
        setGenerationFailure(failure);
        const delay = failure.retryAfterSeconds;
        if (delay)
          setGenerationRetry({
            until: new Date().getTime() + delay * 1000,
            remaining: delay,
          });
      }
      if (
        reason instanceof BuilderError &&
        [401, 403].includes(reason.status)
      ) {
        setWorkspace(null);
        setSavedDraft(null);
      }
      setError(
        reason instanceof Error
          ? reason.message
          : "The tool could not be updated.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    const next = await api<ToolWorkspace>("/api/tool");
    setWorkspace(next);
    return next;
  }

  function loadDraft(draft: ToolDraft) {
    edit(copy(draft.spec));
    setBaseRevision(draft.baseRevision);
    setInstructions(draft.instructions);
    setAssumptions(draft.assumptions);
    setUnsupported(draft.unsupported);
    setSavedDraft(draft);
    setMessage("Review your changes below.");
  }

  async function save() {
    if (!parsed.success || !canSave || errors.length || stale) return;
    await work(async () => {
      const draft = await command<ToolDraft>("/api/tool/drafts", {
        expectedRevision: baseRevision,
        spec: parsed.data,
        instructions,
      });
      loadDraft(draft);
      await refresh();
    });
  }

  async function generate(fresh = false) {
    if (
      !canSave ||
      !instructions.trim() ||
      !parsed.success ||
      stale ||
      retryBlocked ||
      (!fresh && (terminalGeneration || generationFailure?.retryable === false))
    )
      return;
    if (fresh) pendingGeneration.current = null;
    await work(async () => {
      const draft = await command<ToolDraft>("/api/tool/generate", {
        expectedRevision: baseRevision,
        instructions,
        baseSpec: parsed.data,
      });
      loadDraft(draft);
      await refresh();
      setMessage("Review the suggested changes below.");
    }, true);
  }

  async function publish() {
    if (!savedDraft || !canSave || errors.length || stale) return;
    await work(async () => {
      const next = await command<PublishedTool>("/api/tool/publish", {
        draftId: savedDraft.id,
        expectedRevision: baseRevision,
        hash: savedDraft.hash,
      });
      setSpec(copy(next.spec));
      setBaseRevision(next.revision);
      setSavedDraft(null);
      setPreviewing(false);
      onPreview?.(null);
      onPublished(next);
      await refresh();
      setMessage("Desk updated.");
    });
  }

  if (!preview && !owner) return null;

  return (
    <details
      id="tool-builder"
      className="tool-builder tool-builder-simple"
      onToggle={(event) => {
        if (event.target === event.currentTarget) {
          setOpen(event.currentTarget.open);
          if (!event.currentTarget.open) setAiOpen(false);
        }
      }}
    >
      <summary className="tool-builder-entry">
        <strong>Customize this desk</strong>
      </summary>
      {open && (
        <div className="tool-builder-body">
          {preview && (
            <p className="hint">Preview only. Changes aren’t saved.</p>
          )}
          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
          {(busy || message) && (
            <p className="notice" role="status" aria-live="polite">
              {busy ? "Working…" : message}
            </p>
          )}
          <label>
            Desk name
            <input
              maxLength={100}
              value={spec.title}
              disabled={busy}
              onChange={(event) => edit({ ...spec, title: event.target.value })}
            />
          </label>

          <section className="tool-simple-fields" aria-label="Desk fields">
            <h3>Fields</h3>
            {spec.fields.map((field) => (
              <details className="tool-simple-field" key={field.id}>
                <summary>
                  <span>{field.label || "Unnamed field"}</span>
                  <small>
                    {field.type === "textarea" ? "Long text" : "Short text"}
                  </small>
                </summary>
                <div className="tool-simple-field-editor">
                  <label>
                    Field name
                    <input
                      aria-label={`Field label: ${field.id}`}
                      value={field.label}
                      maxLength={80}
                      disabled={busy}
                      onChange={(event) =>
                        editField(field.id, { label: event.target.value })
                      }
                    />
                  </label>
                  {field.id.startsWith("custom_") ? (
                    <div className="tool-builder-field-options">
                      <label className="tool-builder-check">
                        <input
                          type="checkbox"
                          checked={field.visible}
                          disabled={busy}
                          onChange={(event) =>
                            editField(field.id, {
                              visible: event.target.checked,
                            })
                          }
                        />
                        Show field
                      </label>
                      <label>
                        Required
                        <LoomSelect
                          aria-label={`Requirement: ${field.label}`}
                          value={field.requiredAt}
                          disabled={busy}
                          onChange={(event) =>
                            editField(field.id, {
                              requiredAt: event.target
                                .value as ToolField["requiredAt"],
                            })
                          }
                        >
                          <option value="optional">Optional</option>
                          <option value="ready">Before Ready</option>
                          {field.requiredAt === "intake" && (
                            <option value="intake">On new requests</option>
                          )}
                        </LoomSelect>
                      </label>
                      {!current.spec.fields.some(
                        (item) => item.id === field.id,
                      ) && (
                        <button
                          className="quiet"
                          disabled={busy}
                          onClick={() =>
                            edit({
                              ...spec,
                              fields: spec.fields.filter(
                                (item) => item.id !== field.id,
                              ),
                              views: spec.views.map((view) =>
                                view.component === "request-table"
                                  ? {
                                      ...view,
                                      columns: view.columns.filter(
                                        (column) => column !== field.id,
                                      ),
                                    }
                                  : view,
                              ),
                            })
                          }
                        >
                          Remove field
                        </button>
                      )}
                    </div>
                  ) : (
                    <p className="hint">
                      {field.requiredAt === "intake"
                        ? "Required on new requests."
                        : "Required before Ready."}
                    </p>
                  )}
                </div>
              </details>
            ))}
            <details className="tool-simple-add">
              <summary>Add a field</summary>
              <div className="tool-builder-add-field">
                <label>
                  New field label
                  <input
                    value={fieldName}
                    maxLength={80}
                    disabled={busy}
                    onChange={(event) => setFieldName(event.target.value)}
                  />
                </label>
                <label>
                  Answer format
                  <LoomSelect
                    value={fieldType}
                    disabled={busy}
                    onChange={(event) =>
                      setFieldType(event.target.value as "text" | "textarea")
                    }
                  >
                    <option value="text">Short text</option>
                    <option value="textarea">Long text</option>
                  </LoomSelect>
                </label>
                <button
                  className="secondary"
                  disabled={
                    busy ||
                    !fieldName.trim() ||
                    spec.fields.filter((field) =>
                      field.id.startsWith("custom_"),
                    ).length >= 8
                  }
                  onClick={addField}
                >
                  Add field
                </button>
                {spec.fields.filter((field) => field.id.startsWith("custom_"))
                  .length >= 8 && (
                  <small>All eight additional fields are in use.</small>
                )}
              </div>
            </details>
          </section>

          <details className="tool-simple-section">
            <summary>Table columns</summary>
            <fieldset>
              <legend>Queue columns</legend>
              <div className="tool-builder-check-grid">
                {columns.map((column) => (
                  <label className="tool-builder-check" key={column}>
                    <input
                      type="checkbox"
                      disabled={busy || column === "title"}
                      checked={Boolean(queue?.columns.includes(column))}
                      onChange={(event) =>
                        edit({
                          ...spec,
                          views: spec.views.map((view) =>
                            view.component === "request-table"
                              ? {
                                  ...view,
                                  columns: event.target.checked
                                    ? [...view.columns, column]
                                    : view.columns.filter(
                                        (value) => value !== column,
                                      ),
                                }
                              : view,
                          ),
                        })
                      }
                    />
                    {labelFor(column)}
                  </label>
                ))}
              </div>
            </fieldset>
          </details>
          <details className="tool-simple-section">
            <summary>Advanced settings</summary>
            <label>
              Tool description
              <textarea
                rows={2}
                maxLength={1000}
                value={spec.description}
                disabled={busy}
                onChange={(event) =>
                  edit({ ...spec, description: event.target.value })
                }
              />
            </label>
            <div className="tool-builder-template-bar">
              <span>Start from a process</span>
              {processTemplates.map((template) => (
                <button
                  key={template.id}
                  className="secondary"
                  disabled={busy}
                  title={template.description}
                  aria-pressed={sampleTemplate?.id === template.id}
                  onClick={() => chooseTemplate(template.id)}
                >
                  {template.label}
                </button>
              ))}
              <button
                className="quiet"
                disabled={busy}
                onClick={() => {
                  adoptSpec(current.spec, "Published revision");
                }}
              >
                Use latest published
              </button>
            </div>
            <fieldset>
              <legend>Queue filters</legend>
              {(["search", "status"] as const).map((key) => (
                <label className="tool-builder-check" key={key}>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={Boolean(filters?.[key])}
                    onChange={(event) =>
                      edit({
                        ...spec,
                        views: spec.views.map((view) =>
                          view.component === "request-filters"
                            ? { ...view, [key]: event.target.checked }
                            : view,
                        ),
                      })
                    }
                  />
                  {key === "search" ? "Search requests" : "Filter by status"}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>Summary cards</legend>
              <div className="tool-builder-check-grid">
                {(
                  Object.keys(metricLabels) as (keyof typeof metricLabels)[]
                ).map((metric) => (
                  <label className="tool-builder-check" key={metric}>
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={Boolean(summary?.metrics.includes(metric))}
                      onChange={(event) =>
                        edit({
                          ...spec,
                          views: spec.views.map((view) =>
                            view.component === "request-summary"
                              ? {
                                  ...view,
                                  metrics: event.target.checked
                                    ? [...view.metrics, metric]
                                    : view.metrics.filter(
                                        (value) => value !== metric,
                                      ),
                                }
                              : view,
                          ),
                        })
                      }
                    />
                    {metricLabels[metric]}
                  </label>
                ))}
              </div>
            </fieldset>
            <details className="tool-builder-control-group">
              <summary>Status labels</summary>
              <p className="hint">
                Rename how statuses appear. The request workflow stays
                consistent for existing records.
              </p>
              <div className="tool-builder-status-grid">
                {statuses.map((status) => (
                  <label key={status}>
                    {status.replaceAll("_", " ")}
                    <input
                      aria-label={`Status label: ${status}`}
                      maxLength={40}
                      value={spec.statusLabels[status]}
                      disabled={busy}
                      onChange={(event) =>
                        edit({
                          ...spec,
                          statusLabels: {
                            ...spec.statusLabels,
                            [status]: event.target.value,
                          },
                        })
                      }
                    />
                  </label>
                ))}
              </div>
            </details>
          </details>
          <details
            className="tool-simple-section"
            onToggle={(event) => {
              if (event.target === event.currentTarget)
                setAiOpen(event.currentTarget.open);
            }}
          >
            <summary>Ask AI</summary>
            <div className="tool-builder-describe">
              <label>
                Describe your tool or the changes you want
                <textarea
                  aria-label="Describe your tool or the changes you want"
                  rows={3}
                  maxLength={4000}
                  value={instructions}
                  disabled={busy}
                  placeholder="Add an optional Business impact field."
                  onChange={(event) => {
                    setInstructions(event.target.value);
                    setSavedDraft(null);
                    setGenerationFailure(null);
                  }}
                />
              </label>
              <div className="tool-builder-describe-actions">
                <button
                  disabled={
                    busy ||
                    !canSave ||
                    !workspace?.configuration.configured ||
                    !instructions.trim() ||
                    !parsed.success ||
                    stale ||
                    retryBlocked ||
                    terminalGeneration ||
                    generationFailure?.retryable === false
                  }
                  onClick={() => void generate()}
                >
                  {busy
                    ? "Working…"
                    : generationFailure
                      ? "Retry generation"
                      : "Generate a draft"}
                </button>
                {terminalGeneration && (
                  <button
                    className="secondary"
                    disabled={
                      busy ||
                      !canSave ||
                      !workspace?.configuration.configured ||
                      !instructions.trim() ||
                      !parsed.success ||
                      stale ||
                      retryBlocked
                    }
                    onClick={() => void generate(true)}
                  >
                    Start new generation
                  </button>
                )}
                {(preview || !workspace || workspace.configuration.message) && (
                  <small>
                    {preview
                      ? "Connect an AI account to use this option."
                      : !workspace
                        ? "Checking connection…"
                        : workspace.configuration.message}
                  </small>
                )}
              </div>
              {workspace?.configuration.model?.startsWith(
                "openai-chatgpt:",
              ) && (
                <a
                  href="https://chatgpt.com/settings/usage"
                  target="_blank"
                  rel="noreferrer"
                >
                  Manage ChatGPT usage
                </a>
              )}
              {generationRetry && (
                <p className="hint">
                  Retry available in {retryDelay(generationRetry.remaining)}.
                  Your instructions and draft are preserved. Generation runs
                  only when you click.
                </p>
              )}
              {terminalGeneration && (
                <p className="hint">
                  The previous generation cannot be retried. Start a new
                  generation with these instructions when you are ready.
                </p>
              )}
            </div>
          </details>
          <details className="tool-simple-section">
            <summary>Preview</summary>
            <div className="tool-builder-preview-column">
              <div className="tool-builder-preview-heading">
                <span className="eyebrow">Draft preview</span>
                <span className="tool-builder-preview-badge">Layout only</span>
              </div>
              <div
                className="tool-builder-preview"
                aria-label="Draft tool preview"
              >
                <div className="tool-builder-preview-title">
                  <div>
                    <h3>{spec.title || "Untitled tool"}</h3>
                    <p>{spec.description}</p>
                  </div>
                </div>
                {(filters?.search || filters?.status) && (
                  <div className="tool-builder-preview-filters">
                    {filters.search && <span>Search requests…</span>}
                    {filters.status && <span>All statuses</span>}
                  </div>
                )}
                <ToolTable spec={spec} requests={[]} own={false} />
                <div className="tool-builder-preview-intake">
                  <h4>New request</h4>
                  <fieldset disabled aria-label="Draft intake preview">
                    <div className="form-grid">
                      <ToolFields
                        spec={spec}
                        values={{
                          title: "",
                          businessQuestion: "",
                          reportingPeriod: "",
                          dataset: "",
                          customValues: {},
                        }}
                        disabled
                        onChange={() => {}}
                        labelPrefix="Preview: "
                      />
                    </div>
                  </fieldset>
                </div>
              </div>
              {onPreview && (
                <button
                  className="secondary"
                  disabled={busy || !parsed.success}
                  onClick={() => {
                    const next = !previewing;
                    setPreviewing(next);
                    onPreview(next && parsed.success ? parsed.data : null);
                  }}
                >
                  {previewing
                    ? "Return workspace to published tool"
                    : "Preview this draft in the workspace"}
                </button>
              )}
            </div>
          </details>
          {stale && (
            <p className="alert" role="alert">
              A newer revision is published. Your draft is preserved. Review it
              against the latest revision before saving or publishing.{" "}
              <button
                className="quiet"
                disabled={busy}
                onClick={() => {
                  setBaseRevision(current.revision);
                  setSavedDraft(null);
                  setMessage(
                    "Your edits are preserved. Review all differences from the latest published tool, then save a new draft.",
                  );
                }}
              >
                Review draft against latest revision
              </button>
            </p>
          )}
          {errors.length > 0 && (
            <div className="alert" role="alert">
              <strong>Resolve these changes first</strong>
              <ul>
                {errors.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          {compatibility.warnings.length > 0 && (
            <div className="tool-builder-warning">
              <strong>Check existing requests</strong>
              <ul>
                {compatibility.warnings.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          {savedDraft ? (
            <section
              className="tool-builder-review"
              aria-label="Review tool changes"
            >
              <h3>Review changes</h3>
              <ul className="tool-builder-change-list">
                {changes.map((change, index) => (
                  <li key={index}>{change}</li>
                ))}
              </ul>
              {(assumptions.length > 0 ||
                unsupported.length > 0 ||
                savedDraft?.inference) && (
                <div className="tool-builder-model-notes">
                  {savedDraft?.inference && (
                    <>
                      <h4>Generated by {savedDraft.inference.actualModel}</h4>
                      <p className="hint">
                        Reported cost:{" "}
                        {savedDraft.inference.cost === null
                          ? "not reported"
                          : `${savedDraft.inference.cost} USD`}{" "}
                        ·{" "}
                        {savedDraft.inference.durationMs === null
                          ? "unknown duration"
                          : `${(savedDraft.inference.durationMs / 1000).toFixed(1)} seconds`}
                      </p>
                      <details>
                        <summary>Model usage details</summary>
                        <ul style={{ overflowWrap: "anywhere" }}>
                          <li>
                            Requested model:{" "}
                            {savedDraft.inference.requestedModel}
                          </li>
                          <li>
                            Actual model: {savedDraft.inference.actualModel}
                          </li>
                          <li>
                            Input tokens:{" "}
                            {savedDraft.inference.promptTokens ??
                              "not reported"}
                          </li>
                          <li>
                            Output tokens:{" "}
                            {savedDraft.inference.completionTokens ??
                              "not reported"}
                          </li>
                          <li>
                            Generation: {savedDraft.inference.generationId}
                          </li>
                        </ul>
                      </details>
                    </>
                  )}
                  {assumptions.length > 0 && (
                    <>
                      <h4>Model assumptions</h4>
                      <ul>
                        {assumptions.map((item, index) => (
                          <li key={index}>{item}</li>
                        ))}
                      </ul>
                    </>
                  )}
                  {unsupported.length > 0 && (
                    <>
                      <h4>Needs another approach</h4>
                      <ul>
                        {unsupported.map((item, index) => (
                          <li key={index}>{item}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
              <div className="tool-builder-publish-actions">
                <button
                  className="quiet"
                  disabled={busy}
                  onClick={() => {
                    setSavedDraft(null);
                    setMessage("");
                  }}
                >
                  Back to editing
                </button>
                <button
                  disabled={
                    busy ||
                    !canSave ||
                    errors.length > 0 ||
                    stale ||
                    !changes.length
                  }
                  onClick={() => void publish()}
                >
                  Apply changes
                </button>
              </div>
            </section>
          ) : (
            <div className="tool-simple-actions">
              <button
                disabled={
                  busy ||
                  !canSave ||
                  errors.length > 0 ||
                  stale ||
                  !changes.length
                }
                onClick={() => void save()}
              >
                Review changes
              </button>
              <button
                className="quiet"
                disabled={busy || (!changes.length && !stale && !instructions)}
                onClick={() => {
                  adoptSpec(current.spec, "Saved desk");
                  setInstructions("");
                  setMessage("");
                  setPreviewing(false);
                  onPreview?.(null);
                }}
              >
                Reset changes
              </button>
            </div>
          )}
          {canSave && (
            <details className="tool-builder-saved">
              <summary>Saved drafts and publication history</summary>
              <button
                className="quiet"
                disabled={busy}
                onClick={() => void work(refresh)}
              >
                Refresh saved revisions
              </button>
              <div className="tool-builder-history-grid">
                <section>
                  <h3>Saved drafts</h3>
                  {!workspace?.drafts.length && (
                    <p className="muted">Saved drafts will appear here.</p>
                  )}
                  {workspace?.drafts.map((draft) => (
                    <article key={draft.id}>
                      <div>
                        <strong>{draft.spec.title}</strong>
                        <small>
                          From revision {draft.baseRevision} ·{" "}
                          {formatDate(draft.createdAt)}
                        </small>
                      </div>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => loadDraft(draft)}
                      >
                        Review saved draft
                      </button>
                    </article>
                  ))}
                </section>
                <section>
                  <h3>Published revisions</h3>
                  {!workspace?.history.length && (
                    <p className="muted">
                      The built-in template is your starting point.
                    </p>
                  )}
                  {workspace?.history.map((revision) => (
                    <article key={revision.revision}>
                      <div>
                        <strong>
                          Revision {revision.revision} · {revision.spec.title}
                        </strong>
                        <small>{formatDate(revision.publishedAt)}</small>
                      </div>
                      <button
                        className="secondary"
                        disabled={
                          busy || revision.revision === current.revision
                        }
                        onClick={() =>
                          adoptSpec(
                            revision.spec,
                            `Revision ${revision.revision}`,
                          )
                        }
                      >
                        Restore as a new draft
                      </button>
                    </article>
                  ))}
                </section>
              </div>
              <p className="hint">
                Restoring copies a prior tool into a new draft. Review and
                publish it as a new revision; saved requests keep their history.
              </p>
            </details>
          )}
        </div>
      )}
    </details>
  );
}
