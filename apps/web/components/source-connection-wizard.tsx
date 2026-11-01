"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  SourceOption,
  SourceProvider,
  SourceSnapshot,
} from "@loom/contracts";
import { accessRequest } from "./account-access";
import { LoomSelect } from "./ui/loom-select";

export const sourceLabels: Record<SourceProvider, string> = {
  github: "GitHub",
  slack: "Slack",
  discord: "Discord",
  teams: "Microsoft Teams",
  sharepoint: "SharePoint",
};
export const connectionKind = (provider: SourceProvider) =>
  provider === "teams" || provider === "sharepoint" ? "microsoft" : provider;
type Signin = {
  id: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  interval: number;
};
const guides = {
  github: [
    {
      title: "Choose your repositories",
      text: "Create a fine-grained token. Select your company as the resource owner, then Only select repositories.",
      rows: [
        "Resource owner · your company",
        "Only select repositories",
        "analytics / reporting",
      ],
      link: "https://github.com/settings/personal-access-tokens/new",
      action: "Open GitHub",
    },
    {
      title: "Allow read access",
      text: "Under Repository permissions, set these to Read-only. Your organization may need to approve the token.",
      rows: [
        "Contents · Read-only",
        "Issues · Read-only",
        "Pull requests · Read-only",
      ],
      link: "https://github.com/settings/personal-access-tokens",
      action: "Return to GitHub",
    },
    {
      title: "Paste your token",
      text: "Generate the token in GitHub, then paste it below. Loom saves it encrypted on this server.",
      rows: [
        "Fine-grained personal access token",
        "github_pat_••••••••••••",
        "Ready to connect",
      ],
    },
  ],
  slack: [
    {
      title: "Create a Slack app",
      text: "Choose From scratch, name it Loom, and select your workspace.",
      rows: [
        "Create an app · From scratch",
        "App name · Loom",
        "Your workspace",
      ],
      link: "https://api.slack.com/apps",
      action: "Open Slack setup",
    },
    {
      title: "Allow channel reading",
      text: "In OAuth & Permissions, add these User Token Scopes. A user token lets Loom read public-channel threads.",
      rows: ["User Token Scopes", "channels:read", "channels:history"],
      link: "https://api.slack.com/apps",
      action: "Return to Slack",
    },
    {
      title: "Install and connect",
      text: "Install the app to your workspace, then copy its User OAuth Token. Join the public channels you want Loom to read.",
      rows: ["Install to Workspace", "User OAuth Token", "xoxp-••••••••••••"],
    },
  ],
  discord: [
    {
      title: "Create your bot",
      text: "Create an application named Loom. On its Bot page, turn on Message Content Intent.",
      rows: [
        "New Application · Loom",
        "Bot → Privileged Gateway Intents",
        "Message Content Intent · On",
      ],
      link: "https://discord.com/developers/applications",
      action: "Open Discord setup",
    },
    {
      title: "Add it to your server",
      text: "In OAuth2 → URL Generator, choose bot and these permissions. Open the generated link to install it.",
      rows: ["Scope · bot", "View Channels", "Read Message History"],
      link: "https://discord.com/developers/applications",
      action: "Return to Discord",
    },
    {
      title: "Paste your bot token",
      text: "Copy or reset the token on the Bot page. Use a bot token, never your personal Discord account token.",
      rows: ["Bot → Token", "••••••••••••••••", "Selected channels only"],
    },
  ],
  microsoft: [
    {
      title: "Register Loom once",
      text: "In Microsoft Entra, create an app registration for your organization. Under Authentication, enable Allow public client flows.",
      rows: [
        "App registrations → New registration",
        "Name · Loom",
        "Allow public client flows · Yes",
      ],
      link: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
      action: "Open Microsoft Entra",
    },
    {
      title: "Grant read permissions",
      text: "Add Microsoft Graph delegated permissions below, plus offline_access. Ask your administrator to grant consent.",
      rows: [
        "User.Read · Team.ReadBasic.All",
        "Channel.ReadBasic.All",
        "ChannelMessage.Read.All · Sites.Read.All",
      ],
      link: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
      action: "Return to Microsoft",
    },
    {
      title: "Finish local setup",
      text: "Copy the Application ID and Directory ID into these .env settings, then restart Loom and reopen this guide. No client secret is needed.",
      rows: [
        "LOOM_MICROSOFT_CLIENT_ID",
        "LOOM_MICROSOFT_TENANT_ID",
        "Restart Loom → Connect",
      ],
    },
  ],
};
function Example({ provider }: { provider: SourceProvider }) {
  const [stage, setStage] = useState(0);
  const knowledge = provider === "github" || provider === "sharepoint";
  const labels = knowledge
    ? ["Source", "Passage", "Answer"]
    : ["Message", "Request", "Workspace"];
  const content =
    provider === "github"
      ? [
          "analytics/revenue.sql",
          "Revenue = paid orders, excluding refunds.",
          "Revenue excludes refunds. [revenue.sql]",
        ]
      : knowledge
        ? [
            "Metric definitions.pdf",
            "An active customer placed an order in the last 30 days.",
            "Active customers use a 30-day window. [page 2]",
          ]
        : [
            "Can you compare revenue by region for this quarter?",
            "Compare quarterly revenue by region",
            "New request · Ready for review",
          ];
  return (
    <div className="source-demo" aria-label="Import example">
      <div className="source-demo-top">
        <span>Example · not workspace data</span>
        <span>{labels[stage]}</span>
      </div>
      <div className="source-demo-content" key={stage}>
        {content[stage]}
      </div>
      <div className="source-demo-steps">
        {labels.map((label, index) => (
          <button
            type="button"
            key={label}
            aria-pressed={index === stage}
            onClick={() => setStage(index)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
export function SourceConnectionWizard({
  provider,
  workspaceId,
  snapshot: initial,
  onSnapshot,
  onClose,
}: {
  provider: SourceProvider;
  workspaceId: string;
  snapshot: SourceSnapshot;
  onSnapshot: (value: SourceSnapshot) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    heading = useRef<HTMLHeadingElement>(null),
    controller = useRef<AbortController | null>(null),
    pending = useRef(false),
    epoch = useRef(0);
  const id = useId(),
    kind = connectionKind(provider),
    label = sourceLabels[provider];
  const [snapshot, setSnapshot] = useState(initial),
    [step, setStep] = useState(0),
    [guide, setGuide] = useState(0),
    [skipGuide, setSkipGuide] = useState(false);
  const [token, setToken] = useState(""),
    [signin, setSignin] = useState<Signin | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [parents, setParents] = useState<SourceOption[]>([]),
    [options, setOptions] = useState<SourceOption[]>([]),
    [parent, setParent] = useState(""),
    [root, setRoot] = useState(""),
    [query, setQuery] = useState(""),
    [loaded, setLoaded] = useState(false);
  const [shared, setShared] = useState(false),
    [mode, setMode] = useState<"detect" | "all">("detect");
  const connected = snapshot.connections.find((item) => item.provider === kind);
  const direct = provider === "slack" || provider === "github",
    knowledge = provider === "github" || provider === "sharepoint";
  const parentLabel =
    provider === "discord" ? "Server" : provider === "teams" ? "Team" : "Site";
  const rootLabel =
    provider === "github"
      ? "Repository"
      : provider === "sharepoint"
        ? "Document library"
        : "Channel";
  const call = useCallback(
    <T,>(body?: unknown) =>
      accessRequest<T>("/api/workspaces/sources", {
        ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
        headers: { "X-Loom-Workspace": workspaceId },
        signal: controller.current?.signal,
      }),
    [workspaceId],
  );
  const applySnapshot = useCallback(
    (value: SourceSnapshot) => {
      setSnapshot(value);
      onSnapshot(value);
    },
    [onSnapshot],
  );
  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    const element = dialog.current!,
      previous = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => {
      abort.abort();
      element.close();
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    heading.current?.focus();
  }, [step]);
  async function act(task: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
    } catch (cause) {
      if (!controller.current?.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not finish. Try again.",
        );
    } finally {
      pending.current = false;
      if (!controller.current?.signal.aborted) setBusy(false);
    }
  }
  async function browse(parentId = "") {
    const generation = ++epoch.current;
    const response = await call<{ options: SourceOption[] }>({
      action: "browse",
      provider,
      parentId,
      query,
    });
    if (controller.current?.signal.aborted || generation !== epoch.current)
      return;
    if (direct || parentId) setOptions(response.options);
    else setParents(response.options);
    setLoaded(true);
    if (!response.options.length)
      setNotice(
        provider === "slack"
          ? "No channels found. Join a public channel and check the app’s read permissions."
          : "No sources found. Check access or try another search.",
      );
  }
  // Polling, rather than the popup closing, confirms Microsoft's authorization.
  useEffect(() => {
    if (!signin) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (Date.now() >= Date.parse(signin.expiresAt)) {
        setSignin(null);
        setError("Microsoft sign-in expired. Try again.");
        return;
      }
      try {
        const result = await call<{ connected: boolean }>({
          action: "poll-microsoft",
          id: signin.id,
        });
        if (stopped) return;
        if (result.connected) {
          const value = await call<SourceSnapshot>();
          if (!stopped) {
            applySnapshot(value);
            setSignin(null);
            setNotice("Microsoft connected. Continue to choose a source.");
          }
          return;
        }
        timer = setTimeout(() => void poll(), signin.interval * 1000);
      } catch (cause) {
        if (!stopped && !controller.current?.signal.aborted) {
          setSignin(null);
          setError(
            cause instanceof Error
              ? cause.message
              : "Sign-in failed. Try again.",
          );
        }
      }
    };
    timer = setTimeout(() => void poll(), signin.interval * 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [signin, call, applySnapshot]);
  function startMicrosoft() {
    // Open synchronously during the click so browsers can allow the popup.
    const popup = window.open(
      "about:blank",
      "loom-microsoft-signin",
      "popup,width=560,height=720",
    );
    if (popup) popup.opener = null;
    void act(async () => {
      try {
        const value = await call<Signin>({ action: "connect-microsoft" });
        if (controller.current?.signal.aborted) {
          popup?.close();
          return;
        }
        setSignin(value);
        if (popup && !popup.closed) popup.location.href = value.verificationUri;
      } catch (cause) {
        popup?.close();
        throw cause;
      }
    });
  }
  const instructions = guides[kind],
    current = instructions[guide],
    tokenStep = skipGuide || guide === 2;
  return (
    <dialog
      ref={dialog}
      className="source-wizard"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <span>{label}</span>
        <button
          type="button"
          className="quiet"
          onClick={onClose}
          aria-label="Close connection setup"
        >
          Close
        </button>
      </header>
      <ol className="source-wizard-progress" aria-label="Connection progress">
        {["Connect", "Choose", "Import"].map((name, index) => (
          <li
            key={name}
            aria-current={
              step === index || (step === 3 && index === 2) ? "step" : undefined
            }
            data-complete={step > index}
          >
            {String(index + 1).padStart(2, "0")} <span>{name}</span>
          </li>
        ))}
      </ol>
      <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>
        {step === 0
          ? connected
            ? `${label} connected`
            : `Connect ${label}`
          : step === 1
            ? `Choose a ${rootLabel.toLowerCase()}`
            : step === 2
              ? "Ready to import"
              : "Import queued"}
      </h2>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {step === 0 && (
        <>
          {connected ? (
            <div className="source-connected-account">
              <strong>{connected.name}</strong>
              <span>Connected account</span>
              <button
                className="quiet"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    applySnapshot(
                      await call<SourceSnapshot>({
                        action: "disconnect",
                        provider: kind,
                      }),
                    );
                    setSignin(null);
                    setToken("");
                  })
                }
              >
                Disconnect
              </button>
            </div>
          ) : kind === "microsoft" && snapshot.microsoftAvailable ? (
            <>
              <p>Sign in with your company Microsoft account.</p>
              {signin ? (
                <div className="source-signin">
                  <span>Enter this code on Microsoft’s page</span>
                  <strong>{signin.userCode}</strong>
                  <button
                    onClick={() =>
                      void act(async () => {
                        await navigator.clipboard.writeText(signin.userCode);
                        setNotice("Code copied.");
                      })
                    }
                  >
                    Copy code
                  </button>
                  <a
                    href={signin.verificationUri}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Continue to Microsoft
                  </a>
                  <span>Waiting for Microsoft…</span>
                  <button
                    className="quiet"
                    onClick={() => {
                      setSignin(null);
                      setNotice("");
                    }}
                  >
                    Cancel sign-in
                  </button>
                </div>
              ) : (
                <button disabled={busy} onClick={startMicrosoft}>
                  {busy ? "Opening Microsoft…" : "Sign in with Microsoft"}
                </button>
              )}
            </>
          ) : (
            <div className="source-guide">
              {!skipGuide && (
                <>
                  <div className="source-guide-heading">
                    <span>One-time setup · {guide + 1} / 3</span>
                    <h3>{current.title}</h3>
                    <p>{current.text}</p>
                  </div>
                  <div
                    className="source-guide-demo"
                    aria-label="Setup illustration"
                  >
                    <span>Illustration · {label} settings</span>
                    {current.rows.map((row) => (
                      <div key={row}>{row}</div>
                    ))}
                  </div>
                  {"link" in current && (
                    <a
                      className="source-provider-link"
                      href={current.link}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {current.action}
                    </a>
                  )}
                </>
              )}
              {kind !== "microsoft" && tokenStep && (
                <form
                  className="source-token-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act(async () => {
                      const value = await call<SourceSnapshot>({
                        action: `connect-${kind}`,
                        token,
                      });
                      if (controller.current?.signal.aborted) return;
                      applySnapshot(value);
                      setToken("");
                      setNotice(`${label} connected.`);
                    });
                  }}
                >
                  <label>
                    {provider === "github"
                      ? "Fine-grained token"
                      : provider === "discord"
                        ? "Bot token"
                        : "User OAuth token"}
                    <input
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={token}
                      onChange={(event) => setToken(event.target.value)}
                      disabled={busy}
                      required
                    />
                  </label>
                  <button disabled={busy || !token.trim()}>
                    {busy ? "Checking connection…" : "Verify connection"}
                  </button>
                </form>
              )}
              {!skipGuide && (
                <div className="source-guide-nav">
                  {guide > 0 && (
                    <button
                      className="quiet"
                      onClick={() => setGuide(guide - 1)}
                    >
                      Previous step
                    </button>
                  )}
                  {guide < 2 && (
                    <button onClick={() => setGuide(guide + 1)}>
                      Next step
                    </button>
                  )}
                </div>
              )}
              {kind !== "microsoft" && (
                <button
                  className="quiet"
                  onClick={() => setSkipGuide(!skipGuide)}
                >
                  {skipGuide ? "Show setup guide" : "I already have a token"}
                </button>
              )}
            </div>
          )}
          {connected && (
            <>
              <Example provider={provider} />
              <footer>
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      setStep(1);
                      if (provider !== "sharepoint") await browse();
                    })
                  }
                >
                  Choose source
                </button>
              </footer>
            </>
          )}
        </>
      )}
      {step === 1 && (
        <div className="source-selection">
          {provider === "sharepoint" && (
            <form
              className="source-picker-row"
              onSubmit={(event) => {
                event.preventDefault();
                setRoot("");
                setParent("");
                setOptions([]);
                void act(() => browse());
              }}
            >
              <label>
                Find a site
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="e.g. Analytics"
                />
              </label>
              <button disabled={busy || query.trim().length < 2}>
                Find sites
              </button>
            </form>
          )}
          {!direct && parents.length > 0 && (
            <label>
              {parentLabel}
              <LoomSelect
                aria-label={parentLabel}
                value={parent}
                disabled={busy}
                onChange={(event) => {
                  const value = event.target.value;
                  setParent(value);
                  setRoot("");
                  setOptions([]);
                  if (value) void act(() => browse(value));
                }}
              >
                <option value="">Choose {parentLabel.toLowerCase()}</option>
                {parents.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </LoomSelect>
            </label>
          )}
          {(direct || parent) && (
            <label>
              {rootLabel}
              <LoomSelect
                aria-label={rootLabel}
                value={root}
                disabled={busy || !options.length}
                onChange={(event) => {
                  setRoot(event.target.value);
                  setShared(false);
                }}
              >
                <option value="">
                  {busy ? "Loading…" : `Choose ${rootLabel.toLowerCase()}`}
                </option>
                {options.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </LoomSelect>
            </label>
          )}
          {busy && <p role="status">Loading sources…</p>}
          {!busy && (loaded || error) && (
            <button
              className="quiet"
              onClick={() => void act(() => browse(parent))}
            >
              Refresh list
            </button>
          )}
          <Example provider={provider} />
          <footer>
            <button
              className="quiet"
              disabled={busy}
              onClick={() => setStep(0)}
            >
              Back
            </button>
            <button disabled={busy || !root} onClick={() => setStep(2)}>
              Review import
            </button>
          </footer>
        </div>
      )}
      {step === 2 && (
        <div className="source-selection">
          <div className="source-import-summary">
            <strong>{options.find((item) => item.id === root)?.name}</strong>
            <span>
              {provider === "github"
                ? "Default-branch code, docs, issues, pull requests & discussion comments → Knowledge"
                : provider === "sharepoint"
                  ? "Documents → Knowledge"
                  : "Last 30 days of messages → Requests"}
            </span>
          </div>
          {provider === "github" && (
            <details className="source-setup-help">
              <summary>Import limits</summary>
              <p>
                Up to 5,000 files, 256 KB each; text, PDF and DOCX. Generated
                files, binaries and common credential files are excluded. Issues
                and pull requests include up to 100 discussion comments each.
                Git history, review comments, Discussions and build artifacts
                are not imported.
              </p>
            </details>
          )}
          {provider === "discord" && (
            <p className="hint">
              Text and announcement channels. Separate threads, forums, DMs and
              attachments are not imported.
            </p>
          )}
          {!knowledge && (
            <label>
              Import mode
              <LoomSelect
                aria-label="Import mode"
                value={mode}
                onChange={(event) =>
                  setMode(event.target.value as "detect" | "all")
                }
              >
                <option value="detect">Detect analytics requests</option>
                <option value="all">Every post (dedicated intake)</option>
              </LoomSelect>
            </label>
          )}
          <label className="source-share">
            <input
              type="checkbox"
              checked={shared}
              onChange={(event) => setShared(event.target.checked)}
            />
            Share imported content with this Loom workspace
          </label>
          <p className="hint">
            Workspace members may see these copies even if they cannot open the
            originals. Read-only access; Loom never posts to {label}.
          </p>
          {!snapshot.syncEnabled && (
            <p role="status">
              Automatic sync is disabled. Enable LOOM_SOURCE_SYNC on the server
              to import.
            </p>
          )}
          <footer>
            <button
              className="quiet"
              disabled={busy}
              onClick={() => setStep(1)}
            >
              Back
            </button>
            <button
              disabled={busy || !shared}
              onClick={() =>
                void act(async () => {
                  const value = await call<SourceSnapshot>({
                    action: "select",
                    selection: {
                      provider,
                      rootId: root,
                      parentId: parent,
                      requestMode: mode,
                      shareWithWorkspace: shared,
                    },
                  });
                  if (controller.current?.signal.aborted) return;
                  applySnapshot(value);
                  setStep(3);
                })
              }
            >
              {busy ? "Adding source…" : "Start automatic import"}
            </button>
          </footer>
        </div>
      )}
      {step === 3 && (
        <>
          <div className="source-import-summary">
            <strong>{options.find((item) => item.id === root)?.name}</strong>
            <span>
              {snapshot.syncEnabled
                ? "Sync runs while the local Loom server is running."
                : "Enable LOOM_SOURCE_SYNC on the server to start."}
            </span>
          </div>
          <p>Follow import progress in Connected sources.</p>
          <footer>
            <button onClick={onClose}>Done</button>
          </footer>
        </>
      )}
      <p className="source-wizard-status" role="status" aria-live="polite">
        {notice}
      </p>
    </dialog>
  );
}
