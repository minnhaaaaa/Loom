"use client";
import { workspaceFetch } from "./workspace-fetch";

import Link from "next/link";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  toolCompatibility,
  toolSpecChanges,
  type ConversationMessage,
  type ConversationSnapshot,
  type KnowledgeEntry,
  type Membership,
  type PreferredAgent,
  type ToolDraft,
  type ToolSpec,
  type TriageProposal,
} from "@loom/contracts";
import { toolFieldValue } from "@loom/domain";

class ConversationError extends Error {
  constructor(
    message: string,
    public status = 0,
  ) {
    super(message);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await workspaceFetch(path, {
    ...options,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new ConversationError(
      "The workspace did not return a complete response. Your prompt is preserved; try again.",
      response.status,
    );
  }
  if (!response.ok)
    throw new ConversationError(
      body.error?.message || "This request could not be confirmed. Try again.",
      response.status,
    );
  return body as T;
}

const agentNames: Record<PreferredAgent, string> = {
  loom: "Company AI",
  codex: "Codex",
  "claude-code": "Claude Code",
  other: "Your connected agent",
  later: "Workspace assistant",
};

function relativeTime(value: string) {
  return new Date(value).toLocaleTimeString("en-IN", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function ThinkingIndicator() {
  return (
    <div
      className="prompt-waiting prompt-thinking"
      role="status"
      aria-live="polite"
    >
      <span className="prompt-thinking-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>Thinking…</span>
    </div>
  );
}

function ProposalCard({
  proposal,
  spec,
  members,
  canReview,
  busy,
  checked,
  onChecked,
  onReview,
  onEvidence,
}: {
  proposal: TriageProposal;
  spec: ToolSpec;
  members: Membership[];
  canReview: boolean;
  busy: boolean;
  checked: boolean;
  onChecked: (value: boolean) => void;
  onReview: (action: "approve" | "reject") => void;
  onEvidence: (id: string) => void;
}) {
  const { before, after } = proposal.content;
  const name = (id: string | null, fallback: string | null) =>
    members.find((member) => member.userId === id)?.name ||
    fallback ||
    id ||
    "Unassigned";
  const changes = [
    ...spec.fields.map((field) => ({
      id: field.id,
      label: field.label,
      before: toolFieldValue(before, field.id),
      after: toolFieldValue(after, field.id),
    })),
    {
      id: "system:status",
      label: "Status",
      before: spec.statusLabels[before.status],
      after: spec.statusLabels[after.status],
    },
    {
      id: "system:owner",
      label: "Owner",
      before: name(before.ownerId, before.ownerName),
      after: name(after.ownerId, after.ownerName),
    },
    {
      id: "system:priority",
      label: "Priority",
      before: before.priority,
      after: after.priority,
    },
    {
      id: "system:due",
      label: "Due date",
      before: before.dueAt || "",
      after: after.dueAt || "",
    },
  ].filter((change) => change.before !== change.after);
  const pending = proposal.state === "pending";
  return (
    <article
      className="prompt-proposal"
      aria-label={`Proposed changes to ${before.title}`}
    >
      <div className="prompt-result-heading">
        <div>
          <span className="prompt-result-kind">Request update</span>
          <h4>
            {pending
              ? "Review suggested changes"
              : proposal.state === "applied"
                ? "Changes applied"
                : "Changes rejected"}
          </h4>
        </div>
        <span
          className={`prompt-proposal-state prompt-proposal-${proposal.state}`}
        >
          {pending
            ? "Needs your review"
            : proposal.state === "applied"
              ? "Applied"
              : "Rejected"}
        </span>
      </div>
      <p className="prompt-proposal-request">{before.title}</p>
      {pending && (
        <p className="prompt-proposal-intro">
          Review the new details below. Nothing changes until you approve.
        </p>
      )}
      {changes.length > 0 && (
        <dl className="prompt-proposed-values">
          {changes.map((change) => (
            <div
              key={change.id}
              className={
                change.id === "system:status"
                  ? "prompt-proposed-status"
                  : undefined
              }
            >
              <dt>
                {change.label}
                <span>
                  {!change.after ? "Remove" : change.before ? "Update" : "Add"}
                </span>
              </dt>
              <dd>
                {change.id === "system:status" && (
                  <>
                    <span className="prompt-previous-status">
                      {change.before}
                    </span>
                    <span
                      className="prompt-change-arrow"
                      aria-label="changes to"
                    >
                      {" "}
                      →{" "}
                    </span>
                  </>
                )}
                <span>{change.after || "Not set"}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
      {proposal.content.commands.map(
        (command, index) =>
          command.type === "add_comment" && (
            <div className="prompt-comment-change" key={`comment:${index}`}>
              <span>
                {command.visibility === "internal"
                  ? "Internal comment to add"
                  : "Comment visible to the requester"}
              </span>
              <p>{command.body}</p>
            </div>
          ),
      )}
      {proposal.content.uncertainty.length > 0 && (
        <div className="prompt-uncertainty">
          <strong>Before you decide</strong>
          {proposal.content.uncertainty.map((item, index) => (
            <p key={index}>{item}</p>
          ))}
        </div>
      )}
      {proposal.content.evidence.length > 0 && (
        <div className="prompt-source-list">
          <span>Referenced sources</span>
          {proposal.content.evidence.map((source) => (
            <button
              key={source.id}
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => onEvidence(source.id)}
            >
              {source.title} <span>v{source.version}</span>
            </button>
          ))}
        </div>
      )}
      <details className="prompt-proposal-comparison">
        <summary>Compare with current request</summary>
        <dl className="prompt-change-list">
          {changes.map((change) => (
            <div key={change.id}>
              <dt>{change.label}</dt>
              <dd>
                <span>Current: {change.before || "Not set"}</span>
                <span>Proposed: {change.after || "Not set"}</span>
              </dd>
            </div>
          ))}
        </dl>
        {proposal.content.reasons.length > 0 && (
          <div className="prompt-proposal-reason">
            <strong>Why these changes?</strong>
            <p>{proposal.content.reasons.join(" ")}</p>
          </div>
        )}
        <details className="prompt-exact-changes">
          <summary>Technical details</summary>
          <pre>{JSON.stringify(proposal.content.commands, null, 2)}</pre>
          <p>
            Record version {proposal.content.expectedVersion} · review{" "}
            {proposal.hash}
          </p>
        </details>
      </details>
      {pending && canReview && (
        <div className="prompt-review-actions">
          <label>
            <input
              type="checkbox"
              checked={checked}
              disabled={busy}
              onChange={(event) => onChecked(event.target.checked)}
            />
            I reviewed these proposed changes.
          </label>
          <div>
            <button
              type="button"
              disabled={busy || !checked}
              onClick={() => onReview("approve")}
              aria-label={`Approve and apply changes to ${before.title}`}
            >
              Approve and apply
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => onReview("reject")}
              aria-label={`Reject changes to ${before.title}`}
            >
              Reject
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function ToolDraftCard({
  draft,
  spec,
  publishedRevision,
  owner,
  checked,
  busy,
  onChecked,
  onPublish,
}: {
  draft: ToolDraft;
  spec: ToolSpec;
  publishedRevision: number;
  owner: boolean;
  checked: boolean;
  busy: boolean;
  onChecked: (value: boolean) => void;
  onPublish: () => void;
}) {
  const changes = toolSpecChanges(spec, draft.spec);
  const compatibility = toolCompatibility(spec, draft.spec);
  const stale = publishedRevision !== draft.baseRevision;
  const matches = changes.length === 0;
  return (
    <article
      className="prompt-tool-draft"
      aria-label={`Draft tool: ${draft.spec.title}`}
    >
      <div className="prompt-result-heading">
        <div>
          <span className="prompt-result-kind">Draft tool</span>
          <h4>{draft.spec.title}</h4>
        </div>
        <span className="prompt-proposal-state">
          {matches ? "In your workspace" : "Ready to review"}
        </span>
      </div>
      <p>{draft.spec.description}</p>
      <div className="prompt-tool-fields" aria-label="Fields in this draft">
        {draft.spec.fields
          .filter((field) => field.visible)
          .map((field) => (
            <span key={field.id}>{field.label}</span>
          ))}
      </div>
      {draft.assumptions.length > 0 && (
        <div className="prompt-uncertainty">
          <strong>Assumptions to check</strong>
          {draft.assumptions.map((item, index) => (
            <p key={index}>{item}</p>
          ))}
        </div>
      )}
      {draft.unsupported.length > 0 && (
        <div className="prompt-uncertainty">
          <strong>What this draft does not support</strong>
          {draft.unsupported.map((item, index) => (
            <p key={index}>{item}</p>
          ))}
        </div>
      )}
      {!matches && (
        <details className="prompt-exact-changes" open>
          <summary>Changes to your shared tool</summary>
          <ul>
            {changes.map((change, index) => (
              <li key={index}>{change}</li>
            ))}
          </ul>
        </details>
      )}
      {matches ? (
        <p className="prompt-result-note">
          Your workspace already uses this tool definition.
        </p>
      ) : (
        <>
          {stale && (
            <p className="prompt-result-note">
              The shared tool changed after this draft was created. Ask for an
              updated draft before publishing.
            </p>
          )}
          {compatibility.errors.map((error, index) => (
            <p className="prompt-result-note" key={index}>
              {error}
            </p>
          ))}
          {owner && (
            <div className="prompt-review-actions">
              <label>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={busy || stale || compatibility.errors.length > 0}
                  onChange={(event) => onChecked(event.target.checked)}
                />
                I reviewed this tool and its changes.
              </label>
              <button
                type="button"
                disabled={
                  busy || !checked || stale || compatibility.errors.length > 0
                }
                onClick={onPublish}
              >
                Publish shared tool
              </button>
            </div>
          )}
        </>
      )}
    </article>
  );
}

export type PromptWorkspaceProps = {
  spec: ToolSpec;
  membership: Membership | null;
  members?: Membership[];
  workspaceId?: string;
  preferredAgent: PreferredAgent;
  publishedRevision?: number;
  preview: boolean;
  onApplied: () => Promise<void>;
};

export function PromptWorkspace({
  spec,
  membership,
  members = [],
  workspaceId,
  preferredAgent,
  publishedRevision = 1,
  preview,
  onApplied,
}: PromptWorkspaceProps) {
  const [snapshot, setSnapshot] = useState<ConversationSnapshot | null>(null);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(!preview && Boolean(membership));
  const [busy, setBusy] = useState<"sending" | "reviewing" | "">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reviewed, setReviewed] = useState<string[]>([]);
  const [evidence, setEvidence] = useState<KnowledgeEntry | null>(null);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const form = useRef<HTMLFormElement | null>(null);
  const messagesEnd = useRef<HTMLDivElement | null>(null);
  const alive = useRef(true);
  const working = useRef(false);
  const generation = useRef(0);
  const sending = useRef<AbortController | null>(null);
  const pendingSend = useRef<{ prompt: string; id: string } | null>(null);
  const pendingAction = useRef<{ payload: string; id: string } | null>(null);
  const canReview =
    membership?.role === "owner" || membership?.role === "operator";
  const memberId = membership?.userId;
  const memberRole = membership?.role;
  const messages = snapshot?.messages || [];
  const waiting = messages.some((message) => message.state === "pending");
  const agentName =
    agentNames[snapshot?.configuration.provider || preferredAgent];
  const available =
    !preview &&
    Boolean(membership) &&
    Boolean(snapshot?.configuration.configured);

  const clearPrivateState = useCallback(() => {
    setSnapshot(null);
    setEvidence(null);
    setReviewed([]);
  }, []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (working.current) return;
    const current = ++generation.current;
    const result = await request<ConversationSnapshot>("/api/conversation", {
      signal,
    });
    if (alive.current && !signal?.aborted && current === generation.current) {
      setSnapshot(result);
      setLoading(false);
      setError("");
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    if (!preview && memberId) {
      void refresh(controller.signal).catch((cause) => {
        if (controller.signal.aborted || !alive.current) return;
        if (
          cause instanceof ConversationError &&
          [401, 403].includes(cause.status)
        )
          clearPrivateState();
        setError(
          cause instanceof Error
            ? cause.message
            : "Your conversation could not be loaded.",
        );
        setLoading(false);
      });
    }
    return () => {
      alive.current = false;
      controller.abort();
      sending.current?.abort();
    };
  }, [preview, memberId, memberRole, workspaceId, refresh, clearPrivateState]);
  useEffect(() => {
    if (preview || !memberId) return;
    const controller = new AbortController();
    let running = false;
    const load = async () => {
      if (running || working.current || document.visibilityState === "hidden")
        return;
      running = true;
      try {
        await refresh(controller.signal);
      } catch (cause) {
        if (controller.signal.aborted || !alive.current) return;
        if (
          cause instanceof ConversationError &&
          [401, 403].includes(cause.status)
        )
          clearPrivateState();
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not refresh the conversation.",
        );
      } finally {
        running = false;
      }
    };
    const timer = waiting ? setInterval(() => void load(), 3000) : null;
    window.addEventListener("focus", load);
    window.addEventListener("online", load);
    return () => {
      controller.abort();
      if (timer) clearInterval(timer);
      window.removeEventListener("focus", load);
      window.removeEventListener("online", load);
    };
  }, [preview, memberId, memberRole, waiting, refresh, clearPrivateState]);
  useEffect(() => {
    const input = textarea.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(280, Math.max(102, input.scrollHeight))}px`;
  }, [prompt]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const value = prompt.trim();
    if (!value || working.current || !available) return;
    if (pendingSend.current?.prompt !== value)
      pendingSend.current = { prompt: value, id: crypto.randomUUID() };
    const command = pendingSend.current;
    working.current = true;
    setBusy("sending");
    requestAnimationFrame(() =>
      messagesEnd.current?.scrollIntoView({ block: "nearest" }),
    );
    setError("");
    setNotice("");
    const current = ++generation.current;
    const controller = new AbortController();
    sending.current = controller;
    try {
      const next = await request<ConversationSnapshot>("/api/conversation", {
        method: "POST",
        body: JSON.stringify({ commandId: command.id, prompt: value }),
        signal: controller.signal,
      });
      if (
        !alive.current ||
        controller.signal.aborted ||
        current !== generation.current
      )
        return;
      setSnapshot(next);
      pendingSend.current = null;
      const latest = next.messages
        .filter((message) => message.role === "assistant")
        .at(-1);
      if (latest?.state !== "failed") setPrompt("");
      else
        setNotice(
          "Your message was saved. You can edit your prompt and send it again when the agent is available.",
        );
      requestAnimationFrame(() => {
        messagesEnd.current?.scrollIntoView({ block: "nearest" });
        textarea.current?.focus({ preventScroll: true });
      });
    } catch (cause) {
      if (controller.signal.aborted || !alive.current) return;
      if (
        cause instanceof ConversationError &&
        [401, 403].includes(cause.status)
      )
        clearPrivateState();
      setError(
        cause instanceof Error
          ? cause.message
          : "Your request could not be confirmed. Send the same prompt again to check it.",
      );
    } finally {
      working.current = false;
      if (sending.current === controller) sending.current = null;
      if (alive.current) setBusy("");
    }
  }

  async function mutation(path: string, body: object, success: string) {
    if (working.current) return;
    const payload = JSON.stringify({ path, body });
    if (pendingAction.current?.payload !== payload)
      pendingAction.current = { payload, id: crypto.randomUUID() };
    working.current = true;
    setBusy("reviewing");
    setError("");
    setNotice("");
    ++generation.current;
    const controller = new AbortController();
    sending.current = controller;
    try {
      await request(path, {
        method: "POST",
        body: JSON.stringify({ ...body, commandId: pendingAction.current.id }),
        signal: controller.signal,
      });
      if (!alive.current || controller.signal.aborted) return;
      pendingAction.current = null;
      const next = await request<ConversationSnapshot>("/api/conversation", {
        signal: controller.signal,
      });
      if (!alive.current || controller.signal.aborted) return;
      setSnapshot(next);
      setReviewed([]);
      await onApplied();
      if (alive.current) setNotice(success);
    } catch (cause) {
      if (controller.signal.aborted || !alive.current) return;
      if (
        cause instanceof ConversationError &&
        [401, 403].includes(cause.status)
      )
        clearPrivateState();
      setError(
        cause instanceof Error
          ? cause.message
          : "This change could not be confirmed. Retry the unchanged action.",
      );
    } finally {
      working.current = false;
      if (sending.current === controller) sending.current = null;
      if (alive.current) setBusy("");
    }
  }

  async function showEvidence(id: string) {
    try {
      const entry = await request<KnowledgeEntry>(`/api/knowledge/${id}`);
      if (alive.current) setEvidence(entry);
    } catch (cause) {
      if (!alive.current) return;
      if (
        cause instanceof ConversationError &&
        [401, 403].includes(cause.status)
      )
        clearPrivateState();
      setError(
        cause instanceof Error
          ? cause.message
          : "This source could not be opened.",
      );
    }
  }
  const toggleReview = (hash: string, checked: boolean) =>
    setReviewed((current) =>
      checked
        ? [...new Set([...current, hash])]
        : current.filter((value) => value !== hash),
    );
  function renderMessage(message: ConversationMessage) {
    return (
      <article
        key={message.id}
        className={`prompt-message prompt-message-${message.role} prompt-message-${message.state}`}
        aria-label={
          message.role === "user" ? "Your message" : "Assistant response"
        }
      >
        <div className="prompt-message-heading">
          <strong>{message.role === "user" ? "You" : "Assistant"}</strong>
          <time dateTime={message.createdAt}>
            {relativeTime(message.createdAt)}
          </time>
        </div>
        {message.content && (
          <div
            className={`prompt-message-content${message.role === "assistant" ? " prompt-markdown" : ""}`}
          >
            {message.role === "assistant" ? (
              <Markdown
                remarkPlugins={[remarkGfm]}
                skipHtml
                components={{ img: () => null }}
              >
                {message.content}
              </Markdown>
            ) : (
              message.content
                .split(/\n{2,}/)
                .map((paragraph, index) => <p key={index}>{paragraph}</p>)
            )}
          </div>
        )}
        {message.state === "pending" && <ThinkingIndicator />}
        {message.state === "failed" &&
          snapshot?.configuration.provider === "codex" && (
            <a
              href="https://chatgpt.com/settings/usage"
              target="_blank"
              rel="noreferrer"
            >
              Manage usage
            </a>
          )}
        {message.citations && message.citations.length > 0 && (
          <div className="prompt-source-list">
            <span>Referenced sources</span>
            {message.citations.map((source) => (
              <button
                type="button"
                key={source.id}
                className="quiet"
                disabled={Boolean(busy)}
                onClick={() => void showEvidence(source.id)}
              >
                {source.title}
                <span>v{source.version}</span>
              </button>
            ))}
          </div>
        )}
        {message.proposals?.map((proposal) => (
          <ProposalCard
            key={proposal.content.id}
            proposal={proposal}
            spec={spec}
            members={members}
            canReview={canReview}
            busy={Boolean(busy)}
            checked={reviewed.includes(proposal.hash)}
            onChecked={(checked) => toggleReview(proposal.hash, checked)}
            onReview={(action) =>
              void mutation(
                `/api/proposals/${proposal.content.id}`,
                { hash: proposal.hash, action },
                action === "approve"
                  ? "Approved changes applied to the workspace."
                  : "Proposal rejected.",
              )
            }
            onEvidence={(id) => void showEvidence(id)}
          />
        ))}
        {message.toolDraft && (
          <ToolDraftCard
            draft={message.toolDraft}
            spec={spec}
            publishedRevision={publishedRevision}
            owner={membership?.role === "owner"}
            busy={Boolean(busy)}
            checked={reviewed.includes(message.toolDraft.hash)}
            onChecked={(checked) =>
              toggleReview(message.toolDraft!.hash, checked)
            }
            onPublish={() =>
              void mutation(
                "/api/tool/publish",
                {
                  draftId: message.toolDraft!.id,
                  expectedRevision: message.toolDraft!.baseRevision,
                  hash: message.toolDraft!.hash,
                },
                "Your shared tool is published.",
              )
            }
          />
        )}
      </article>
    );
  }

  return (
    <section
      id="prompt-workspace"
      className={`prompt-workspace${messages.length ? " prompt-workspace-active" : ""}`}
      aria-label="Workspace assistant"
    >
      <header className="prompt-heading">
        <h1>What would you like to do?</h1>
      </header>
      {loading && (
        <p className="prompt-loading" role="status">
          Opening your conversation…
        </p>
      )}
      {snapshot?.hasMore && (
        <p className="prompt-history-note">
          Showing your most recent conversation. Earlier messages remain saved.
        </p>
      )}
      {(messages.length > 0 || busy === "sending") && (
        <div className="prompt-conversation" aria-label="Your conversation">
          {messages.map(renderMessage)}
          {busy === "sending" && !waiting && (
            <>
              <article
                className="prompt-message prompt-message-user"
                aria-label="Your message"
              >
                <div className="prompt-message-heading">
                  <strong>You</strong>
                </div>
                <div className="prompt-message-content">
                  <p>{prompt.trim()}</p>
                </div>
              </article>
              <article
                className="prompt-message prompt-message-assistant"
                aria-label="Assistant is thinking"
              >
                <div className="prompt-message-heading">
                  <strong>Assistant</strong>
                </div>
                <ThinkingIndicator />
              </article>
            </>
          )}
          <div ref={messagesEnd} />
        </div>
      )}
      {evidence && (
        <aside className="prompt-source-detail" aria-label="Referenced source">
          <div className="prompt-result-heading">
            <div>
              <span className="prompt-result-kind">Referenced source</span>
              <h3>{evidence.title}</h3>
            </div>
            <button
              type="button"
              className="quiet"
              onClick={() => setEvidence(null)}
            >
              Close source
            </button>
          </div>
          <p className="prompt-result-note">
            Current version {evidence.version} · {evidence.state}
          </p>
          <p className="prompt-source-body">{evidence.content}</p>
        </aside>
      )}
      {error && (
        <div className="prompt-error" role="alert">
          <p>{error}</p>
          {!snapshot && !preview && membership && (
            <button
              type="button"
              className="quiet"
              disabled={Boolean(busy)}
              onClick={() =>
                void refresh().catch((cause) =>
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "Could not load the conversation.",
                  ),
                )
              }
            >
              Try loading again
            </button>
          )}
        </div>
      )}
      <form
        ref={form}
        className="prompt-composer"
        onSubmit={(event) => void send(event)}
      >
        <label className="sr-only" htmlFor="workspace-prompt">
          Ask your workspace
        </label>
        <textarea
          id="workspace-prompt"
          ref={textarea}
          aria-label="Ask your workspace"
          value={prompt}
          maxLength={4000}
          rows={3}
          placeholder="Which requests need clarification before an analyst can start?"
          disabled={preview || !membership || busy === "sending"}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              form.current?.requestSubmit();
            }
          }}
        />
        <div className="prompt-composer-footer">
          <span>{preview ? "Sample workspace" : agentName}</span>
          <button
            type="submit"
            disabled={!available || Boolean(busy) || !prompt.trim()}
          >
            {busy === "sending" ? "Sending…" : "Send"}
          </button>
        </div>
      </form>
      <div className="prompt-composer-note">
        {snapshot?.configuration.mode === "builtin" &&
          snapshot.configuration.provider === "codex" && (
            <p>
              Using ChatGPT plan ·{" "}
              <a
                href="https://chatgpt.com/settings/usage"
                target="_blank"
                rel="noreferrer"
              >
                Manage usage
              </a>
            </p>
          )}
        <p>
          {preview || !membership
            ? "Sign in to a connected workspace to ask your agent."
            : snapshot && !snapshot.configuration.configured
              ? snapshot.configuration.message
              : "Changes are shown for your review before they are applied."}
        </p>
        {!preview &&
          membership?.role === "owner" &&
          snapshot &&
          !snapshot.configuration.configured && (
            <Link href="/app?view=settings#company-setup">
              Set up your agent
            </Link>
          )}
      </div>
      <p className="prompt-feedback" role="status" aria-live="polite">
        {busy === "reviewing" ? "Saving your decision…" : notice}
      </p>
    </section>
  );
}
