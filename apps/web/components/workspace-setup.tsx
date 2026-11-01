"use client";
import { LoomSelect } from "./ui/loom-select";
import { CodexConnection } from "./codex-connection";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  workspaceBrandingSchema,
  type WorkspaceBranding,
  type WorkspaceSettings,
  type PreferredAgent,
  type AgentClient,
  type AgentConnection,
  type CreatedAgentConnection,
} from "@loom/contracts";
import { AccessError, accessRequest } from "./account-access";

const steps = ["Your company", "Look and feel", "Your agent", "Ready to work"];
const palettes = [
  { name: "Violet", primary: "#19161e", accent: "#e1bdff" },
  { name: "Forest", primary: "#163d27", accent: "#c9f36b" },
  { name: "Indigo", primary: "#3832a0", accent: "#d9c9ff" },
  { name: "Ocean", primary: "#064a76", accent: "#78e2df" },
  { name: "Ember", primary: "#813626", accent: "#ffd08c" },
  { name: "Graphite", primary: "#242831", accent: "#c2d3ef" },
];
const agentOptions: {
  id: PreferredAgent;
  label: string;
  description: string;
}[] = [
  {
    id: "codex",
    label: "ChatGPT",
    description: "Use your plan. No API key.",
  },
  {
    id: "claude-code",
    label: "Claude Code",
    description: "Connect your Claude Code workspace.",
  },
  {
    id: "other",
    label: "Another agent",
    description: "Use a compatible MCP client.",
  },
  {
    id: "loom",
    label: "Company AI",
    description:
      "Use your company API connection or the configured server model.",
  },
  {
    id: "later",
    label: "Set up later",
    description: "Start with your team’s request desk.",
  },
];
function external(agent: PreferredAgent): agent is AgentClient {
  return ["codex", "claude-code", "other"].includes(agent);
}
function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}
async function normalizedLogo(file: File) {
  if (
    !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
    file.size > 2 * 1024 * 1024
  )
    throw new Error("Choose a PNG, JPEG, or WebP logo smaller than 2 MB.");
  const image = await createImageBitmap(file);
  try {
    if (
      !image.width ||
      !image.height ||
      image.width > 8192 ||
      image.height > 8192
    )
      throw new Error(
        "Choose a logo no larger than 8192 pixels on either side.",
      );
    const scale = Math.min(1, 256 / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser could not prepare your logo.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const result = canvas.toDataURL("image/png");
    if (result.length > 180_000)
      throw new Error(
        "This logo is too detailed. Choose a simpler or smaller image.",
      );
    return result;
  } finally {
    image.close();
  }
}

export function WorkspaceSetup({
  settings,
  workspaceId,
  workspaceName,
  preview,
  initiallyOpen,
  onPreview,
  onSaved,
}: {
  settings: WorkspaceSettings;
  workspaceId?: string;
  workspaceName: string;
  preview: boolean;
  initiallyOpen: boolean;
  onPreview: (branding: WorkspaceBranding | null) => void;
  onSaved: (settings: WorkspaceSettings) => void;
}) {
  function setupBranding(branding: WorkspaceBranding): WorkspaceBranding {
    return {
      ...structuredClone(branding),
      companyName: branding.companyName.trim() || workspaceName.trim(),
    };
  }
  const [open, setOpen] = useState(initiallyOpen && !settings.setupCompletedAt);
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<WorkspaceBranding>(() =>
    setupBranding(settings.branding),
  );
  const draftRef = useRef(draft);
  const [logoLoading, setLogoLoading] = useState(false);
  const [agent, setAgent] = useState<PreferredAgent>(settings.preferredAgent);
  const [base, setBase] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [connections, setConnections] = useState<AgentConnection[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<CreatedAgentConnection | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [origin, setOrigin] = useState("");
  const pending = useRef<{ payload: string; id: string } | null>(null);
  const working = useRef(false);
  const logoGeneration = useRef(0);
  const dirty = !same(draft, base.branding) || agent !== base.preferredAgent;
  const stale = settings.version !== base.version;
  const valid = workspaceBrandingSchema.safeParse(draft);
  const endpoint = origin ? `${origin}/api/mcp` : "";
  const serverName = `loom_${workspaceId?.replaceAll("-", "").slice(0, 8) || "workspace"}`;
  const tokenEnvironment = `LOOM_AGENT_TOKEN_${workspaceId?.replaceAll("-", "").slice(0, 8).toUpperCase() || "WORKSPACE"}`;
  const config =
    agent === "codex"
      ? `[mcp_servers.${serverName}]\nurl = ${JSON.stringify(endpoint)}\nbearer_token_env_var = "${tokenEnvironment}"`
      : JSON.stringify(
          {
            mcpServers: {
              [serverName]: {
                type: "http",
                url: endpoint,
                headers: {
                  Authorization: "Bearer ${" + tokenEnvironment + "}",
                },
              },
            },
          },
          null,
          2,
        );

  useEffect(
    () => () => {
      ++logoGeneration.current;
    },
    [],
  );
  useEffect(() => {
    const followHash = () => {
      if (window.location.hash === "#company-setup") setOpen(true);
      if (window.location.hash === "#company-provider") {
        const panel = document.getElementById("company-provider");
        if (panel instanceof HTMLDetailsElement) panel.open = true;
      }
      if (window.location.hash === "#codex-connection") {
        setOpen(true);
        setStep(2);
        setAgent("codex");
      }
    };
    const timer = setTimeout(followHash, 0);
    window.addEventListener("hashchange", followHash);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("hashchange", followHash);
    };
  }, []);

  const refreshConnections = useCallback(async (signal?: AbortSignal) => {
    const next = await accessRequest<{
      connections: AgentConnection[];
      hasMore: boolean;
    }>("/api/workspaces/agents", { signal });
    if (!signal?.aborted) {
      setConnections(next.connections);
      setHasMore(next.hasMore);
    }
  }, []);
  useEffect(() => {
    if (!open || preview) return;
    const controller = new AbortController();
    let running = false;
    const load = async () => {
      if (running || document.visibilityState === "hidden") return;
      running = true;
      try {
        await refreshConnections(controller.signal);
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (cause instanceof AccessError && [401, 403].includes(cause.status)) {
          setConnections([]);
          setCreated(null);
          onPreview(null);
        }
        setError(
          cause instanceof Error
            ? cause.message
            : "Agent connections could not be loaded.",
        );
      } finally {
        running = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [open, preview, refreshConnections, onPreview]);

  async function command<T>(path: string, values: object): Promise<T> {
    const payload = JSON.stringify({ path, values });
    if (pending.current?.payload !== payload)
      pending.current = { payload, id: crypto.randomUUID() };
    const next = await accessRequest<T>(path, {
      method: "POST",
      body: JSON.stringify({ ...values, commandId: pending.current.id }),
    });
    pending.current = null;
    return next;
  }
  async function work(action: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (cause) {
      if (cause instanceof AccessError && [401, 403].includes(cause.status)) {
        setConnections([]);
        setCreated(null);
        onPreview(null);
      }
      setError(
        cause instanceof Error
          ? cause.message
          : "Setup could not be saved. Retry the unchanged action.",
      );
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  function edit(values: Partial<WorkspaceBranding>) {
    const next = { ...draftRef.current, ...values };
    draftRef.current = next;
    setDraft(next);
    setNotice("");
    const parsed = workspaceBrandingSchema.safeParse(next);
    if (parsed.success) onPreview(parsed.data);
  }
  function useSaved() {
    ++logoGeneration.current;
    setLogoLoading(false);
    draftRef.current = setupBranding(settings.branding);
    setBase(settings);
    setDraft(setupBranding(settings.branding));
    setAgent(settings.preferredAgent);
    setError("");
    onPreview(null);
    setNotice("Saved company settings loaded.");
  }
  async function uploadLogo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const generation = ++logoGeneration.current;
    setLogoLoading(true);
    setError("");
    try {
      const logoDataUrl = await normalizedLogo(file);
      if (generation === logoGeneration.current) edit({ logoDataUrl });
    } catch (cause) {
      if (generation === logoGeneration.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "This logo could not be read.",
        );
    } finally {
      if (generation === logoGeneration.current) setLogoLoading(false);
    }
    event.target.value = "";
  }
  async function save(completeSetup: boolean) {
    if (!valid.success) {
      setError("Use valid six-digit hex colors before saving.");
      return;
    }
    await work(async () => {
      const next = await command<WorkspaceSettings>(
        "/api/workspaces/settings",
        {
          expectedVersion: base.version,
          branding: valid.data,
          preferredAgent: agent,
          completeSetup,
        },
      );
      draftRef.current = setupBranding(next.branding);
      setBase(next);
      setDraft(setupBranding(next.branding));
      setAgent(next.preferredAgent);
      onSaved(next);
      onPreview(null);
      setNotice(
        completeSetup
          ? "Company setup complete. Your team now sees this brand in the shared workspace."
          : "Company settings saved for everyone in this workspace.",
      );
      if (completeSetup) setStep(3);
    });
  }
  async function issueToken() {
    if (!external(agent)) return;
    await work(async () => {
      const next = await command<CreatedAgentConnection>(
        "/api/workspaces/agents",
        {
          label:
            label.trim() ||
            `${agentOptions.find((option) => option.id === agent)?.label} connection`,
          client: agent,
        },
      );
      setCreated(next);
      setShowToken(false);
      await refreshConnections();
      setNotice(
        next.token
          ? "Connection created. Copy its token now, then configure your agent."
          : "This connection was already created. Its token cannot be shown again; revoke it and create another if you did not keep it.",
      );
    });
  }
  async function revoke(connection: AgentConnection) {
    await work(async () => {
      await command(`/api/workspaces/agents/${connection.id}/revoke`, {
        expectedVersion: connection.version,
      });
      if (created?.connection.id === connection.id) setCreated(null);
      await refreshConnections();
      setNotice(
        "Agent connection revoked. This token can no longer access the workspace.",
      );
    });
  }
  async function copy(value: string, message: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(message);
    } catch {
      setError(
        "Copy was unavailable. Select the displayed text and copy it manually.",
      );
    }
  }
  function go(next: number) {
    setOrigin(window.location.origin);
    setStep(next);
    setError("");
    requestAnimationFrame(() =>
      document
        .getElementById(`setup-step-${next}`)
        ?.focus({ preventScroll: true }),
    );
  }

  return (
    <details
      id="company-setup"
      className="company-setup"
      open={open}
      onToggle={(event) => {
        if (event.target === event.currentTarget) {
          const next = event.currentTarget.open;
          setOpen(next);
          if (!next) {
            ++logoGeneration.current;
            setLogoLoading(false);
            onPreview(null);
          } else if (dirty && valid.success) onPreview(valid.data);
        }
      }}
    >
      <summary className="setup-entry">
        <span className="setup-entry-copy">
          <strong>
            {settings.setupCompletedAt
              ? "Company brand and agents"
              : "Make this workspace yours"}
          </strong>
          {settings.setupCompletedAt && (
            <span>
              Update your brand, manage agent access, or revisit setup.
            </span>
          )}
        </span>
        <span className="setup-entry-status">
          {settings.setupCompletedAt ? "Manage setup" : "Start company setup"}
        </span>
      </summary>
      {open && (
        <div className="setup-body">
          <div className="setup-title">
            <div>
              <p className="eyebrow">Welcome to your company’s Loom</p>
              <h2>Your team should feel at home.</h2>
              <p>
                Bring your identity and connect the agent your team already
                works with.
              </p>
            </div>
            <span className="setup-live">Live brand preview</span>
          </div>
          {preview && (
            <p className="banner compact">
              Explore your company’s look with sample data. Sign in as a
              workspace owner to save settings or create an agent connection.
            </p>
          )}
          <nav className="setup-steps" aria-label="Company setup steps">
            {steps.map((name, index) => (
              <button
                key={name}
                className="quiet"
                disabled={busy}
                aria-current={step === index ? "step" : undefined}
                onClick={() => go(index)}
              >
                <span aria-hidden="true">{index + 1}</span>
                {name}
              </button>
            ))}
          </nav>
          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
          {stale && (
            <p className="banner compact">
              Company settings changed in another session. Your draft is
              preserved.{" "}
              <button className="quiet" disabled={busy} onClick={useSaved}>
                Load latest saved settings
              </button>
            </p>
          )}
          <p className="notice" role="status" aria-live="polite">
            {busy ? "Saving…" : notice}
          </p>
          <div className="setup-split">
            <div className="setup-editor">
              {step === 0 && (
                <section aria-labelledby="setup-step-0">
                  <p className="eyebrow">01 / Your company</p>
                  <h3 id="setup-step-0" tabIndex={-1}>
                    Put your name on it.
                  </h3>
                  <label>
                    Company name
                    <input
                      value={draft.companyName}
                      maxLength={100}
                      disabled={busy}
                      placeholder={workspaceName || "Your company"}
                      onChange={(event) =>
                        edit({ companyName: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Company logo
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      disabled={busy}
                      onChange={(event) => void uploadLogo(event)}
                    />
                  </label>
                  {draft.logoDataUrl && (
                    <button
                      className="quiet"
                      disabled={busy}
                      onClick={() => {
                        ++logoGeneration.current;
                        setLogoLoading(false);
                        edit({ logoDataUrl: null });
                      }}
                    >
                      Remove company logo
                    </button>
                  )}
                </section>
              )}
              {step === 1 && (
                <section aria-labelledby="setup-step-1">
                  <p className="eyebrow">02 / Look and feel</p>
                  <h3 id="setup-step-1" tabIndex={-1}>
                    Start with your colors.
                  </h3>
                  <p className="hint">
                    Pick a palette or use your brand’s exact colors. Text and
                    surfaces adapt to keep the workspace readable.
                  </p>
                  <div
                    className="setup-palettes"
                    role="group"
                    aria-label="Brand color palettes"
                  >
                    {palettes.map((palette) => (
                      <button
                        key={palette.name}
                        className="secondary"
                        disabled={busy}
                        aria-pressed={
                          draft.primaryColor.toLowerCase() ===
                            palette.primary &&
                          draft.accentColor.toLowerCase() === palette.accent
                        }
                        onClick={() =>
                          edit({
                            primaryColor: palette.primary,
                            accentColor: palette.accent,
                          })
                        }
                      >
                        <span
                          className="setup-palette-dot"
                          style={{ background: palette.primary }}
                        />
                        <span
                          className="setup-palette-dot"
                          style={{ background: palette.accent }}
                        />
                        {palette.name}
                      </button>
                    ))}
                  </div>
                  <div className="setup-color-grid">
                    {(
                      [
                        ["primaryColor", "Primary color"],
                        ["accentColor", "Accent color"],
                      ] as const
                    ).map(([key, title]) => (
                      <div key={key}>
                        <label>
                          {title}
                          <input
                            aria-label={`${title} hex`}
                            value={draft[key]}
                            maxLength={7}
                            disabled={busy}
                            spellCheck={false}
                            onChange={(event) =>
                              edit({ [key]: event.target.value })
                            }
                          />
                        </label>
                        <input
                          type="color"
                          aria-label={`${title} picker`}
                          value={
                            /^#[0-9a-f]{6}$/i.test(draft[key])
                              ? draft[key]
                              : "#000000"
                          }
                          disabled={busy}
                          onChange={(event) =>
                            edit({ [key]: event.target.value })
                          }
                        />
                      </div>
                    ))}
                  </div>
                  <div className="setup-color-grid">
                    <label>
                      Typography
                      <LoomSelect
                        aria-label="Typography"
                        value={draft.font}
                        disabled={busy}
                        onChange={(event) =>
                          edit({
                            font: event.target
                              .value as WorkspaceBranding["font"],
                          })
                        }
                      >
                        <option value="modern">Modern · Manrope</option>
                        <option value="classic">Classic · Georgia</option>
                        <option value="technical">
                          Technical · IBM Plex Mono
                        </option>
                      </LoomSelect>
                    </label>
                    <label>
                      Corner style
                      <LoomSelect
                        aria-label="Corner style"
                        value={draft.corners}
                        disabled={busy}
                        onChange={(event) =>
                          edit({
                            corners: event.target
                              .value as WorkspaceBranding["corners"],
                          })
                        }
                      >
                        <option value="rounded">Rounded</option>
                        <option value="square">Square</option>
                      </LoomSelect>
                    </label>
                  </div>
                  {!valid.success && (
                    <p className="alert">
                      Use six-digit hex colors such as #3832a0.
                    </p>
                  )}
                </section>
              )}
              {step === 2 && (
                <section aria-labelledby="setup-step-2">
                  <p className="eyebrow">03 / Your agent</p>
                  <h3 id="setup-step-2" tabIndex={-1}>
                    Choose your AI.
                  </h3>
                  <div
                    className="setup-agent-options"
                    role="group"
                    aria-label="Choose your agent"
                  >
                    {agentOptions.map((option) => (
                      <button
                        key={option.id}
                        className="secondary"
                        aria-pressed={agent === option.id}
                        disabled={busy}
                        onClick={() => {
                          setAgent(option.id);
                          setError("");
                        }}
                      >
                        <strong>{option.label}</strong>
                        <small>{option.description}</small>
                      </button>
                    ))}
                  </div>
                  {agent === "codex" && (
                    <CodexConnection
                      preview={preview}
                      workspaceId={workspaceId}
                    />
                  )}
                  {external(agent) && (
                    <details
                      className="setup-agent-connect"
                      open={agent !== "codex"}
                    >
                      <summary>
                        {agent === "codex"
                          ? "Local Codex connection"
                          : "Local agent connection"}
                      </summary>
                      <label>
                        Connection name
                        <input
                          value={label}
                          maxLength={100}
                          placeholder={`${agentOptions.find((option) => option.id === agent)?.label} for ${draft.companyName || workspaceName}`}
                          disabled={busy}
                          onChange={(event) => setLabel(event.target.value)}
                        />
                      </label>
                      <button
                        disabled={busy || preview}
                        onClick={() => void issueToken()}
                      >
                        Create agent connection
                      </button>
                      <p className="hint">
                        This issues a Loom access token for this workspace. Your
                        agent keeps its own account and runs in your
                        environment.
                      </p>
                      {created?.token && (
                        <div className="setup-secret">
                          <label>
                            New agent access token
                            <input
                              type={showToken ? "text" : "password"}
                              aria-label="New agent access token"
                              readOnly
                              value={created.token}
                              autoComplete="off"
                              spellCheck={false}
                            />
                          </label>
                          <div>
                            <button
                              className="secondary"
                              onClick={() =>
                                void copy(
                                  created.token!,
                                  `Agent token copied. Set it as ${tokenEnvironment} in your agent’s environment.`,
                                )
                              }
                            >
                              Copy agent token
                            </button>
                            <button
                              className="quiet"
                              onClick={() => setShowToken(!showToken)}
                            >
                              {showToken ? "Hide token" : "Show token"}
                            </button>
                            <button
                              className="quiet"
                              onClick={() => setCreated(null)}
                            >
                              Dismiss token
                            </button>
                          </div>
                          <p className="hint">
                            Keep this token now. It will not be shown after a
                            reload. It expires after 30 days; you can revoke it
                            below.
                          </p>
                        </div>
                      )}
                      <h4>
                        Connect{" "}
                        {
                          agentOptions.find((option) => option.id === agent)
                            ?.label
                        }
                      </h4>
                      <ol className="setup-instructions">
                        <li>
                          Set <code>{tokenEnvironment}</code> in the environment
                          where you launch your agent, using the token above.
                        </li>
                        <li>
                          {agent === "codex" ? (
                            <>
                              Add this server entry to your Codex{" "}
                              <code>config.toml</code>.
                            </>
                          ) : (
                            <>
                              Add this entry to your client’s MCP configuration
                              {agent === "claude-code" ? (
                                <>
                                  {" "}
                                  in <code>.mcp.json</code>
                                </>
                              ) : (
                                ""
                              )}
                              .
                            </>
                          )}
                        </li>
                      </ol>
                      <pre
                        className="setup-config"
                        aria-label="Agent connection configuration"
                      >
                        {config}
                      </pre>
                      <button
                        className="secondary"
                        onClick={() =>
                          void copy(config, "Agent configuration copied.")
                        }
                      >
                        Copy agent configuration
                      </button>
                      <p className="hint">
                        Restart or reconnect your client, then ask it to read
                        your Loom workspace.{" "}
                        {agent === "codex" ? (
                          <a
                            href="https://developers.openai.com/codex/mcp"
                            target="_blank"
                            rel="noreferrer"
                          >
                            Codex connection guide
                          </a>
                        ) : agent === "claude-code" ? (
                          <a
                            href="https://code.claude.com/docs/en/mcp"
                            target="_blank"
                            rel="noreferrer"
                          >
                            Claude Code connection guide
                          </a>
                        ) : null}
                      </p>
                      <div className="setup-callout">
                        <strong>Let your agent answer prompts in Loom.</strong>
                        <p>
                          Ask your connected client to check{" "}
                          <code>loom_list_tasks</code>, handle your team’s
                          pending prompts, and finish each answer with{" "}
                          <code>loom_reply_task</code>. It can attach proposed
                          record changes or prepare a tool draft with{" "}
                          <code>loom_propose_tool</code> for an owner to review.
                        </p>
                        <p>
                          Keep that client running and ask it to check for new
                          prompts. Loom saves the prompts and displays its
                          replies; this connection does not start your client
                          automatically. Changes still require approval in Loom.
                        </p>
                      </div>
                    </details>
                  )}
                  {agent === "loom" && (
                    <p className="setup-callout">
                      Loom’s built-in agent uses the model configured on this
                      server. Choosing it saves your preference; model
                      availability is shown in the agent workspace.
                    </p>
                  )}
                  {agent === "later" && (
                    <p className="setup-callout">
                      You can finish company setup now and connect an agent here
                      whenever your team is ready.
                    </p>
                  )}
                  {!preview && (
                    <div className="setup-connections">
                      <div className="setup-connections-title">
                        <h4>Workspace agent access</h4>
                        <button
                          className="quiet"
                          disabled={busy}
                          onClick={() => void work(() => refreshConnections())}
                        >
                          Refresh agent status
                        </button>
                      </div>
                      {!connections.length && (
                        <p className="hint">
                          No external agent connections yet.
                        </p>
                      )}
                      {hasMore && (
                        <p className="hint">
                          Showing the latest 100 connections.
                        </p>
                      )}
                      {connections.map((connection) => (
                        <article key={connection.id}>
                          <div>
                            <strong>{connection.label}</strong>
                            <p>
                              {connection.revokedAt
                                ? "Revoked"
                                : connection.expiresAt <=
                                    new Date().toISOString()
                                  ? "Expired"
                                  : connection.lastUsedAt
                                    ? `Last used ${new Date(connection.lastUsedAt).toLocaleString("en-IN")}`
                                    : "Awaiting first agent request"}
                            </p>
                            <small>
                              {connection.client}
                              {connection.clientName
                                ? ` · ${connection.clientName}`
                                : ""}{" "}
                              · expires{" "}
                              {new Date(
                                connection.expiresAt,
                              ).toLocaleDateString("en-IN")}
                            </small>
                          </div>
                          {!connection.revokedAt && (
                            <button
                              className="quiet"
                              disabled={busy}
                              onClick={() => void revoke(connection)}
                            >
                              Revoke {connection.label}
                            </button>
                          )}
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              )}
              {step === 3 && (
                <section aria-labelledby="setup-step-3">
                  <p className="eyebrow">04 / Ready to work</p>
                  <h3 id="setup-step-3" tabIndex={-1}>
                    A workspace that belongs to you.
                  </h3>
                  <dl className="setup-review">
                    <div>
                      <dt>Company</dt>
                      <dd>
                        {draft.companyName.trim() || "Add your company name"}
                      </dd>
                    </div>
                    <div>
                      <dt>Brand palette</dt>
                      <dd>
                        {draft.primaryColor} / {draft.accentColor}
                      </dd>
                    </div>
                    <div>
                      <dt>Look</dt>
                      <dd>
                        {draft.font} · {draft.corners} corners
                      </dd>
                    </div>
                    <div>
                      <dt>Agent preference</dt>
                      <dd>
                        {
                          agentOptions.find((option) => option.id === agent)
                            ?.label
                        }
                      </dd>
                    </div>
                  </dl>
                  <p className="hint">
                    Publish these settings for everyone in this workspace. You
                    can change your brand or manage agent connections here any
                    time.
                  </p>
                  {external(agent) && (
                    <p className="hint">
                      Agent access is ready when your client makes its first
                      authenticated request. Finishing setup does not launch an
                      agent session.
                    </p>
                  )}
                  {!draft.companyName.trim() && (
                    <p className="hint">
                      Add your company name in step 1 to finish setup.{" "}
                      <button
                        type="button"
                        className="quiet"
                        onClick={() => setStep(0)}
                      >
                        Go to company name
                      </button>
                    </p>
                  )}
                  <button
                    disabled={
                      busy ||
                      logoLoading ||
                      preview ||
                      stale ||
                      !valid.success ||
                      !draft.companyName.trim()
                    }
                    onClick={() => void save(true)}
                  >
                    {settings.setupCompletedAt
                      ? "Save company setup"
                      : "Finish company setup"}
                  </button>
                  {settings.setupCompletedAt && !dirty && (
                    <a
                      className="setup-launch"
                      href="#request-queue"
                      onClick={() => {
                        setOpen(false);
                        onPreview(null);
                      }}
                    >
                      Open your workspace
                    </a>
                  )}
                </section>
              )}
            </div>
          </div>
          <div className="setup-footer">
            {(preview || !dirty) && (
              <span>
                {preview
                  ? "Unsaved sample exploration"
                  : `Saved settings · version ${base.version}`}
              </span>
            )}
            <div>
              {step > 0 && (
                <button
                  className="quiet"
                  disabled={busy}
                  onClick={() => go(step - 1)}
                >
                  Back
                </button>
              )}
              <button className="secondary" disabled={busy} onClick={useSaved}>
                Reset to saved brand
              </button>
              {step < 3 && (
                <button
                  disabled={busy || !valid.success}
                  onClick={() => go(step + 1)}
                >
                  Continue
                </button>
              )}
              {!preview && step < 3 && (
                <button
                  className="secondary"
                  disabled={busy || logoLoading || stale || !valid.success}
                  onClick={() => void save(false)}
                >
                  Save settings
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </details>
  );
}
