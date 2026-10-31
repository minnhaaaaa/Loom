"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CsvTransfer } from "./csv-transfer";
import { TriageWorkspace } from "./triage-workspace";
import { ToolBuilder } from "./tool-builder";
import { PromptWorkspace } from "./prompt-workspace";
import { TeamMemory } from "./team-memory";
import { AnalyticsInsights } from "./analytics-insights";
import { ProviderSettings } from "./provider-settings";
import { workspaceFetch } from "./workspace-fetch";
import { WorkspaceSetup } from "./workspace-setup";
import { ToolFields, ToolTable, ToolSummary } from "./tool-renderer";
import { Arrow, CompanyMark } from "./ui/civitas";
import { brandTheme } from "@loom/domain";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type CSSProperties,
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
  type PublishedTool,
  type Membership,
  type WorkspaceBranding,
  defaultWorkspaceSettings,
} from "@loom/contracts";

const defaultTool: PublishedTool = {
  revision: 1,
  spec: toolSpec,
  publishedAt: null,
};
type Detail = {
  tool?: PublishedTool;
  membership?: Membership;
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
  const response = await workspaceFetch(path, {
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
function StatusBadge({
  status,
  labels = statusLabels,
}: {
  status: Status;
  labels?: typeof statusLabels;
}) {
  return (
    <span className={`status status-${status}`}>
      <span aria-hidden="true" />
      {labels[status]}
    </span>
  );
}
const emptyIntake: Intake = {
  title: "",
  businessQuestion: "",
  reportingPeriod: "",
  dataset: "",
};
type DescriptionBase = { requestId: string; version: number; values: Intake };
function descriptionValues(values: Intake): Intake {
  return {
    title: values.title,
    businessQuestion: values.businessQuestion,
    reportingPeriod: values.reportingPeriod,
    dataset: values.dataset,
    customValues: { ...values.customValues },
  };
}
function sameDescription(left: Intake, right: Intake) {
  const signature = (values: Intake) =>
    JSON.stringify({
      ...descriptionValues(values),
      customValues: Object.fromEntries(
        Object.entries(values.customValues || {}).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    });
  return signature(left) === signature(right);
}
export function Desk({
  initial,
  initialError,
  onSessionChanged,
  workspaceControls,
  showDemoControls = true,
  setupInitiallyOpen = false,
  initialView,
}: {
  initial: DeskSnapshot;
  initialError: string | null;
  onSessionChanged?: () => Promise<void>;
  workspaceControls?: ReactNode;
  showDemoControls?: boolean;
  setupInitiallyOpen?: boolean;
  initialView?: "assistant" | "records" | "settings" | "insights" | "knowledge";
}) {
  const router = useRouter();
  const [view] = useState(
    initialView ||
      (setupInitiallyOpen &&
      initial.membership?.role === "owner" &&
      !initial.settings?.setupCompletedAt
        ? "settings"
        : "records"),
  );
  const [desk, setDesk] = useState(initial),
    [error, setError] = useState(initialError),
    [notice, setNotice] = useState("");
  const [brandPreview, setBrandPreview] = useState<WorkspaceBranding | null>(
    null,
  );
  const companySettings = desk.settings || defaultWorkspaceSettings;
  const branding = brandPreview || companySettings.branding;
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
  const intakeRef = useRef<Intake>(emptyIntake);
  const [descriptionBase, setDescriptionBase] =
    useState<DescriptionBase | null>(null);
  const descriptionBaseRef = useRef<DescriptionBase | null>(null);
  const selectedRef = useRef<string | null>(null);
  const detailRef = useRef<Detail | null>(null);
  const membershipRef = useRef(initial.membership);
  const workspaceRef = useRef(initial.workspace?.id);
  const sessionGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const mutating = useRef(false);
  const [comment, setComment] = useState(""),
    [visibility, setVisibility] = useState<"internal" | "requester_visible">(
      "requester_visible",
    );
  const [page, setPage] = useState(0);
  const tool = desk.tool || defaultTool;
  const spec = tool.spec;
  const [formTool, setFormTool] = useState<PublishedTool>(
    initial.tool || defaultTool,
  );
  const filters = spec.views.find((view) => view.id === "filters");
  const currentDetailTool = detail?.tool || tool;
  const actionEnabled = (action: string) =>
    currentDetailTool.spec.actions.some((id) => id === `request.${action}`);
  const refreshGeneration = useRef(0);
  const invalidateRefresh = useCallback(() => {
    ++refreshGeneration.current;
  }, []);
  const changingIdentity = useRef(false);
  const pendingCommand = useRef<{ payload: string; id: string } | null>(null);
  const preview = desk.mode === "preview",
    member = desk.membership;
  const memberId = member?.userId;
  const refreshIntervalMs = Math.max(1000, desk.refreshIntervalMs || 3000);
  const operates = member?.role === "owner" || member?.role === "operator";
  const viewHref = (next: string) =>
    `/app?${preview ? "demo=1&" : ""}view=${next}`;
  const canWrite = !preview && Boolean(member) && member?.role !== "viewer";
  const setDraft = useCallback((values: Intake) => {
    intakeRef.current = values;
    setIntake(values);
  }, []);
  const setCurrentDetail = useCallback((value: Detail | null) => {
    detailRef.current = value;
    setDetail(value);
  }, []);
  const pinDescription = useCallback(
    (request: PublicRequest, published: PublishedTool) => {
      const values = descriptionValues(request);
      const baseline = {
        requestId: request.id,
        version: request.version,
        values,
      };
      descriptionBaseRef.current = baseline;
      setDescriptionBase(baseline);
      setDraft(values);
      setFormTool(published);
    },
    [setDraft],
  );
  const clearDescription = useCallback(() => {
    descriptionBaseRef.current = null;
    setDescriptionBase(null);
    setDraft(emptyIntake);
  }, [setDraft]);
  const clearAuthorizedData = useCallback(() => {
    ++sessionGeneration.current;
    ++refreshGeneration.current;
    ++detailGeneration.current;
    selectedRef.current = null;
    membershipRef.current = null;
    workspaceRef.current = undefined;
    pendingCommand.current = null;
    setDesk((current) => ({
      ...current,
      membership: null,
      requests: [],
      members: [],
      tool: defaultTool,
      workspace: undefined,
      settings: undefined,
    }));
    setBrandPreview(null);
    setSearch("");
    setStatus("all");
    setPage(0);
    setSelected(null);
    setCreating(false);
    setCurrentDetail(null);
    setDetailLoading(false);
    clearDescription();
    setFormTool(defaultTool);
    setComment("");
    setVisibility("requester_visible");
    setAnalytics(null);
    setNotice("");
  }, [clearDescription, setCurrentDetail]);
  const applyMembership = useCallback(
    (next: Membership | null) => {
      const previous = membershipRef.current;
      membershipRef.current = next;
      if (
        previous &&
        (previous.role !== next?.role || previous.userId !== next?.userId)
      ) {
        setBrandPreview(null);
        ++sessionGeneration.current;
        ++detailGeneration.current;
        pendingCommand.current = null;
        setCurrentDetail(null);
        clearDescription();
        setComment("");
        setVisibility("requester_visible");
        setAnalytics(null);
        if (previous.userId !== next?.userId) {
          selectedRef.current = null;
          setSelected(null);
          setCreating(false);
          setFormTool(defaultTool);
          setSearch("");
          setStatus("all");
          setPage(0);
        }
        if (selectedRef.current) {
          setDetailLoading(true);
          setDetailRevision((value) => value + 1);
        }
      }
    },
    [clearDescription, setCurrentDetail],
  );
  const refresh = useCallback(async () => {
    if (changingIdentity.current) return;
    const generation = ++refreshGeneration.current;
    const current = () => generation === refreshGeneration.current;
    try {
      const params = new URLSearchParams({
        search,
        status,
        page: String(page),
      });
      const next = await api<DeskSnapshot>(`/api/desk?${params}`);
      if (!current()) return;
      if (!next.membership) {
        clearAuthorizedData();
        return;
      }
      if (
        workspaceRef.current &&
        next.workspace?.id &&
        workspaceRef.current !== next.workspace.id
      ) {
        clearAuthorizedData();
        membershipRef.current = next.membership;
        workspaceRef.current = next.workspace.id;
        setDesk(next);
        setError(null);
        return;
      }
      workspaceRef.current = next.workspace?.id;
      applyMembership(next.membership);
      const nextFilters = next.tool?.spec.views.find(
        (view) => view.id === "filters",
      );
      if (nextFilters?.id === "filters") {
        if (!nextFilters.search && search) {
          setSearch("");
          setPage(0);
        }
        if (!nextFilters.status && status !== "all") {
          setStatus("all");
          setPage(0);
        }
      }
      setDesk(next);
      setError(null);
      if (next.membership?.role !== "requester") {
        try {
          const result = await api<AnalyticsResult>("/api/analytics");
          if (current()) setAnalytics(result);
        } catch (cause) {
          if (!current()) return;
          if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
            clearAuthorizedData();
            setError(cause.message);
          } else setAnalytics(null);
        }
      } else setAnalytics(null);
    } catch (e) {
      if (!current()) return;
      if (e instanceof ApiError && [401, 403].includes(e.status)) {
        clearAuthorizedData();
      }
      setError(e instanceof Error ? e.message : "Could not refresh.");
    }
  }, [search, status, page, applyMembership, clearAuthorizedData]);
  useEffect(() => {
    if (preview || !memberId) return;
    const timer = setInterval(() => void refresh(), refreshIntervalMs);
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    window.addEventListener("online", focus);
    const firstPoll = setTimeout(() => void refresh(), 250);
    return () => {
      clearInterval(timer);
      clearTimeout(firstPoll);
      window.removeEventListener("focus", focus);
      window.removeEventListener("online", focus);
    };
  }, [preview, memberId, refresh, refreshIntervalMs]); // Identity is the polling boundary.
  const refreshDetails = useCallback(
    async (signal?: AbortSignal) => {
      const id = selectedRef.current;
      if (!id || preview || changingIdentity.current || mutating.current)
        return;
      const generation = ++detailGeneration.current;
      const session = sessionGeneration.current;
      const current = () =>
        !signal?.aborted &&
        generation === detailGeneration.current &&
        session === sessionGeneration.current &&
        selectedRef.current === id;
      try {
        const data = await api<Detail>(`/api/requests/${id}`, { signal });
        if (!current()) return;
        if (
          data.membership &&
          data.membership.role !== membershipRef.current?.role
        ) {
          applyMembership(data.membership);
          setDesk((value) => ({
            ...value,
            membership: data.membership!,
            requests: [],
            members: [],
          }));
          void refresh();
          return;
        }
        if (
          detailRef.current?.request.id === id &&
          data.request.version < detailRef.current.request.version
        )
          return;
        const baseline = descriptionBaseRef.current;
        const dirty =
          baseline?.requestId === id &&
          !sameDescription(intakeRef.current, baseline.values);
        setCurrentDetail(data);
        if (!dirty) pinDescription(data.request, data.tool || defaultTool);
        setError(null);
      } catch (cause) {
        if (
          !current() ||
          (cause instanceof Error && cause.name === "AbortError")
        )
          return;
        if (cause instanceof ApiError && [401, 403].includes(cause.status))
          clearAuthorizedData();
        else if (cause instanceof ApiError && cause.status === 404) {
          selectedRef.current = null;
          setSelected(null);
          setCurrentDetail(null);
          clearDescription();
          setComment("");
          void refresh();
        }
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not refresh this request.",
        );
      } finally {
        if (current()) setDetailLoading(false);
      }
    },
    [
      preview,
      applyMembership,
      clearAuthorizedData,
      clearDescription,
      pinDescription,
      refresh,
      setCurrentDetail,
    ],
  );
  useEffect(() => {
    if (!selected || preview || !memberId) return;
    const controller = new AbortController();
    const load = () => void refreshDetails(controller.signal);
    load();
    const timer = setInterval(load, refreshIntervalMs);
    window.addEventListener("focus", load);
    window.addEventListener("online", load);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", load);
      window.removeEventListener("online", load);
    };
  }, [
    selected,
    preview,
    memberId,
    detailRevision,
    refreshDetails,
    refreshIntervalMs,
  ]);
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
    changingIdentity.current = true;
    invalidateRefresh();
    setBusy(true);
    setError(null);
    try {
      await api("/api/session", {
        method: "POST",
        body: JSON.stringify({ userId }),
      });
      clearAuthorizedData();
      if (onSessionChanged) {
        await onSessionChanged();
        return;
      }
      changingIdentity.current = false;
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      changingIdentity.current = false;
      setBusy(false);
    }
  }
  async function signOut() {
    changingIdentity.current = true;
    invalidateRefresh();
    setBusy(true);
    try {
      await api("/api/session", { method: "DELETE", body: "{}" });
      clearAuthorizedData();
      setNotice("Signed out.");
      await onSessionChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      changingIdentity.current = false;
      setBusy(false);
    }
  }
  async function submit(
    path: string,
    payload: object,
  ): Promise<PublicRequest | null> {
    if (mutating.current) return null;
    mutating.current = true;
    ++detailGeneration.current;
    const session = sessionGeneration.current;
    setBusy(true);
    setError(null);
    setNotice("");
    const serialized = JSON.stringify({ path, ...payload });
    if (pendingCommand.current?.payload !== serialized)
      pendingCommand.current = { payload: serialized, id: crypto.randomUUID() };
    try {
      const saved = await api<PublicRequest>(path, {
        method: "POST",
        body: JSON.stringify({
          ...payload,
          commandId: pendingCommand.current.id,
        }),
      });
      if (session !== sessionGeneration.current) return null;
      pendingCommand.current = null;
      await refresh();
      if (session !== sessionGeneration.current) return null;
      setNotice("Changes saved.");
      return saved;
    } catch (e) {
      if (session !== sessionGeneration.current) return null;
      if (e instanceof ApiError && [401, 403].includes(e.status))
        clearAuthorizedData();
      setError((e as Error).message);
      return null;
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!canWrite) return;
    if (
      await submit("/api/requests", {
        values: intake,
        expectedToolRevision: formTool.revision,
      })
    ) {
      setCreating(false);
      clearDescription();
    }
  }
  async function command(value: Command) {
    if (!detail || !canWrite) return;
    const id = detail.request.id;
    const description = value.type === "edit_description";
    const baseline = descriptionBaseRef.current;
    const expectedVersion =
      description && baseline?.requestId === id
        ? baseline.version
        : detail.request.version;
    const commandTool = description ? formTool : currentDetailTool;
    const saved = await submit(`/api/requests/${detail.request.id}/commands`, {
      expectedVersion,
      command: value,
      expectedToolRevision: commandTool.revision,
    });
    if (saved && selectedRef.current === id) {
      const latest = detailRef.current;
      if (latest && latest.request.version <= saved.version)
        setCurrentDetail({ ...latest, request: saved });
      if (description) pinDescription(saved, commandTool);
      await refreshDetails();
    } else if (!saved && selectedRef.current === id) {
      await refreshDetails();
    }
    if (saved && value.type === "add_comment") setComment("");
  }
  const filtered = preview
    ? desk.requests.filter(
        (r) =>
          (status === "all" || r.status === status) &&
          `${r.title} ${r.businessQuestion} ${r.requesterName} ${r.ownerName || ""}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      )
    : desk.requests;
  const own = member?.role === "requester";
  function openCreate() {
    ++detailGeneration.current;
    selectedRef.current = null;
    setFormTool(tool);
    setSelected(null);
    setCreating(true);
    setCurrentDetail(null);
    clearDescription();
    setComment("");
    setError(null);
  }
  function closePanel() {
    ++detailGeneration.current;
    selectedRef.current = null;
    setSelected(null);
    setCreating(false);
    setCurrentDetail(null);
    clearDescription();
    setComment("");
  }
  const descriptionDirty = Boolean(
    descriptionBase && !sameDescription(intake, descriptionBase.values),
  );
  const descriptionConflict = Boolean(
    detail &&
    descriptionBase &&
    descriptionDirty &&
    (detail.request.version !== descriptionBase.version ||
      currentDetailTool.revision !== formTool.revision),
  );
  const descriptionDiff = detail
    ? currentDetailTool.spec.fields.map((field) => ({
        id: field.id,
        label: field.label,
        saved: field.id.startsWith("custom_")
          ? detail.request.customValues?.[field.id] || ""
          : String(detail.request[field.id as keyof PublicRequest] || ""),
        draft: field.id.startsWith("custom_")
          ? intake.customValues?.[field.id] || ""
          : String(intake[field.id as keyof Intake] || ""),
      }))
    : [];
  return (
    <div
      className="app-shell"
      data-workspace-id={desk.workspace?.id}
      data-company-theme
      style={brandTheme(branding) as CSSProperties}
    >
      <a
        className="skip-link"
        href="#workspace-main"
        inert={creating || Boolean(selected)}
      >
        Skip to workspace
      </a>
      <aside className="sidebar" inert={creating || Boolean(selected)}>
        <Link
          className="brand"
          href="/"
          aria-label={`${branding.companyName || "Loom"} home`}
        >
          <CompanyMark branding={branding} />
        </Link>
        <span className="brand-caption">
          {branding.companyName
            ? "Your workspace, powered by Loom"
            : "Less chasing. More analysis."}
        </span>
        <p className="workspace-label">
          {desk.workspace?.name || "Analytics workspace"}
        </p>
        <nav aria-label="Main">
          <Link
            href={viewHref("assistant")}
            className={view === "assistant" ? "nav-active" : ""}
            aria-current={view === "assistant" ? "page" : undefined}
          >
            <span className="nav-icon" aria-hidden="true">
              ◇
            </span>
            <span className="nav-label">Ask your assistant</span>
          </Link>
          <Link
            href={viewHref("records")}
            className={view === "records" ? "nav-active" : ""}
            aria-current={view === "records" ? "page" : undefined}
          >
            <span className="nav-icon" aria-hidden="true">
              ▦
            </span>
            <span className="nav-label">Data requests</span>
            <span className="nav-count">{desk.requests.length}</span>
          </Link>
          {(preview || operates) && (
            <>
              <Link
                href={viewHref("insights")}
                className={view === "insights" ? "nav-active" : ""}
                aria-current={view === "insights" ? "page" : undefined}
              >
                <span className="nav-icon" aria-hidden="true">
                  ↗
                </span>
                <span className="nav-label">Flow insights</span>
              </Link>
              <Link
                href={viewHref("knowledge")}
                className={view === "knowledge" ? "nav-active" : ""}
                aria-current={view === "knowledge" ? "page" : undefined}
              >
                <span className="nav-icon" aria-hidden="true">
                  ◎
                </span>
                <span className="nav-label">Team knowledge</span>
              </Link>
            </>
          )}
          {(preview || member) && (
            <Link
              href={viewHref("settings")}
              className={view === "settings" ? "nav-active" : ""}
              aria-current={view === "settings" ? "page" : undefined}
            >
              <span className="nav-icon" aria-hidden="true">
                ◎
              </span>
              <span className="nav-label">Workspace settings</span>
            </Link>
          )}
          {(preview || member?.role === "owner") && (
            <Link
              href={`${viewHref("settings")}#company-setup`}
              onClick={() => {
                const setup = document.getElementById("company-setup");
                if (setup instanceof HTMLDetailsElement) setup.open = true;
              }}
            >
              <span className="nav-icon" aria-hidden="true">
                ◈
              </span>
              <span className="nav-label">Company setup</span>
              <Arrow />
            </Link>
          )}
        </nav>
        <label className="mobile-workspace-navigation">
          <span className="sr-only">Workspace view</span>
          <select
            aria-label="Workspace view"
            value={view}
            onChange={(event) => router.push(viewHref(event.target.value))}
          >
            <option value="assistant">Ask your assistant</option>
            <option value="records">Data requests</option>
            {(preview || operates) && (
              <>
                <option value="insights">Flow insights</option>
                <option value="knowledge">Team knowledge</option>
              </>
            )}
            {(preview || member) && (
              <option value="settings">Workspace settings</option>
            )}
          </select>
        </label>
        <div className="sidebar-note">
          <span className="sidebar-orbit" aria-hidden="true">
            <i />
            <i />
            <b>L</b>
          </span>
          <strong>
            Clear requests.
            <br />
            Focused analysts.
          </strong>
          <p>
            Give every question context,
            <br />
            an owner, and a next step.
          </p>
        </div>
        <div className="environment">
          <span className={preview ? "dot neutral" : "dot"} />
          {preview ? "Sample preview" : "Shared workspace"}
        </div>
      </aside>
      <main
        id="workspace-main"
        tabIndex={-1}
        inert={creating || Boolean(selected)}
      >
        <header className="topbar">
          <span>
            Workspace <span aria-hidden="true">/</span>{" "}
            <strong>
              {view === "assistant"
                ? "Your assistant"
                : view === "settings"
                  ? "Workspace settings"
                  : view === "insights"
                    ? "Flow insights"
                    : view === "knowledge"
                      ? "Team knowledge"
                      : spec.title}
            </strong>
          </span>
          <span className="workspace-presence">
            <span className="dot" aria-hidden="true" />
            {preview
              ? "Explore Loom"
              : member
                ? `${member.name} · ${member.role}`
                : "Make room for teamwork"}
          </span>
        </header>
        <div
          className={`content${view === "assistant" ? " content-assistant" : ""}`}
        >
          {preview && view !== "assistant" && (
            <div className="banner">
              <strong>Read-only sample preview</strong>
              <span>
                Explore synthetic requests without saving changes. Create your
                company to invite colleagues and manage your own queue.
              </span>
            </div>
          )}
          {!preview &&
            workspaceControls &&
            (view === "settings" || !member) && (
              <div id="workspace-access">{workspaceControls}</div>
            )}
          {!preview &&
            showDemoControls &&
            (view !== "assistant" || !member) && (
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
          {view === "settings" && (
            <div className="page-heading">
              <div>
                <p className="eyebrow">Manage your workspace</p>
                <h1>Workspace settings</h1>
                <p>Company identity, teammates, and approved context.</p>
                <p className="current-tool-label">
                  Published tool: {spec.title} · revision {tool.revision}
                </p>
              </div>
              <Link href={viewHref("assistant")}>
                Return to your assistant ↗
              </Link>
            </div>
          )}
          {view === "settings" && (preview || member?.role === "owner") && (
            <WorkspaceSetup
              key={`setup/${desk.workspace?.id || "preview"}/${member?.userId || "preview"}`}
              settings={companySettings}
              workspaceId={desk.workspace?.id}
              workspaceName={desk.workspace?.name || "Your company"}
              preview={preview}
              initiallyOpen={setupInitiallyOpen}
              onPreview={setBrandPreview}
              onSaved={(settings) => {
                if (
                  membershipRef.current?.role !== "owner" ||
                  membershipRef.current.userId !== member?.userId ||
                  workspaceRef.current !== desk.workspace?.id
                )
                  return;
                invalidateRefresh();
                setDesk((current) => ({ ...current, settings }));
              }}
            />
          )}
          {view === "insights" &&
            (preview || operates) &&
            (preview ? (
              <section className="empty">
                <h1>See where requests wait.</h1>
                <p>
                  Flow insights calculates waiting time, backlog trends and
                  analyst workload from your company’s saved request history in
                  Exasol.
                </p>
                <p>There is no live history in this sample workspace.</p>
                <Link href="/register">Create your company ↗</Link>
              </section>
            ) : (
              <>
                <div className="page-heading">
                  <div>
                    <p className="eyebrow">The work behind the answer</p>
                    <h1>Flow insights</h1>
                    <p>
                      See where requests wait and how work moves through your
                      team.
                    </p>
                  </div>
                </div>
                <AnalyticsInsights
                  key={`insights/${desk.workspace?.id}/${memberId}/${member?.role}`}
                  refreshKey={`${desk.workspace?.id}/${memberId}/${member?.role}/${desk.requests.map((r) => `${r.id}:${r.version}`).join(",")}`}
                />
              </>
            ))}
          {view === "knowledge" &&
            (preview || operates) &&
            (preview ? (
              <section className="empty">
                <h1>A shared understanding.</h1>
                <p>
                  Keep approved metric definitions, routing procedures and
                  reviewed decisions alongside your team’s requests.
                </p>
                <Link href="/register">Create your company ↗</Link>
              </section>
            ) : (
              <>
                <div className="page-heading">
                  <div>
                    <p className="eyebrow">Context your team can rely on</p>
                    <h1>Team knowledge</h1>
                    <p>
                      Approved definitions, procedures, and decisions with their
                      sources.
                    </p>
                  </div>
                </div>
                <TeamMemory
                  key={`memory/${desk.workspace?.id}/${memberId}`}
                  refreshKey={`${desk.workspace?.id}/${memberId}/${member?.role}`}
                />
                <TriageWorkspace
                  key={`knowledge/${desk.workspace?.id}/${memberId}`}
                  owner={member?.role === "owner"}
                  requests={desk.requests}
                  members={desk.members}
                  spec={spec}
                  preferredAgent={companySettings.preferredAgent}
                  onApplied={refresh}
                />
              </>
            ))}
          {view === "settings" &&
            !preview &&
            member?.role === "owner" &&
            desk.workspace && (
              <ProviderSettings
                key={`provider/${desk.workspace.id}/${memberId}`}
                workspaceId={desk.workspace.id}
              />
            )}
          {view === "records" && (
            <div className="page-heading">
              <div>
                <p className="eyebrow">
                  {own ? "Your work, in view" : "Your analytics request queue"}
                </p>
                <h1>{spec.title}</h1>
                <p>{spec.description}</p>
              </div>
              <button
                onClick={openCreate}
                disabled={
                  busy ||
                  (!preview && !canWrite) ||
                  !spec.actions.includes("request.create")
                }
                className="new-request-button"
              >
                + New request <Arrow />
              </button>
            </div>
          )}
          {view === "settings" && (preview || member?.role === "owner") && (
            <ToolBuilder
              key={member?.userId || "preview"}
              published={tool}
              membership={member}
              preview={preview}
              onPublished={(next) => {
                if (
                  !preview &&
                  (membershipRef.current?.role !== "owner" ||
                    membershipRef.current.userId !== member?.userId ||
                    workspaceRef.current !== desk.workspace?.id)
                )
                  return;
                setDesk((current) => ({ ...current, tool: next }));
                setSearch("");
                setStatus("all");
                setPage(0);
                setNotice(
                  `Tool revision ${next.revision} published. Colleagues receive it on refresh.`,
                );
                void refresh();
              }}
            />
          )}
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
          {view === "assistant" && (preview || member) && (
            <PromptWorkspace
              key={`prompt/${desk.workspace?.id}/${member?.userId}/${member?.role}`}
              spec={spec}
              publishedRevision={tool.revision}
              membership={member}
              workspaceId={desk.workspace?.id}
              members={desk.members}
              preferredAgent={companySettings.preferredAgent}
              preview={preview}
              onApplied={refresh}
            />
          )}
          {view === "records" && (preview || member) && (
            <>
              <ToolSummary
                spec={spec}
                requests={desk.requests}
                analytics={analytics}
              />
              <div className="summary-source">
                {analytics
                  ? `Exasol · ${analytics.queryId} · checked ${new Date(analytics.queriedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`
                  : preview
                    ? "Sample counts · not live SQL results"
                    : "Counts cover this page · use the queue summary for workspace totals"}
                {analytics &&
                spec.fields.some(
                  (field) =>
                    field.id.startsWith("custom_") &&
                    field.requiredAt !== "optional",
                )
                  ? " · Missing requirements covers this page, including custom fields."
                  : ""}
              </div>
              <section
                id="request-queue"
                className="queue"
                aria-label="Request queue"
              >
                <div className="queue-toolbar">
                  {filters?.id === "filters" && filters.search && (
                    <label className="search">
                      <span className="sr-only">Search requests</span>
                      <input
                        type="search"
                        placeholder="Search requests, people, or context…"
                        value={search}
                        maxLength={200}
                        onChange={(e) => {
                          setSearch(e.target.value);
                          setPage(0);
                          ++refreshGeneration.current;
                        }}
                      />
                    </label>
                  )}
                  {filters?.id === "filters" && filters.status && (
                    <label className="inline-label">
                      Status{" "}
                      <select
                        value={status}
                        onChange={(e) => {
                          setStatus(e.target.value);
                          setPage(0);
                          ++refreshGeneration.current;
                        }}
                      >
                        <option value="all">All statuses</option>
                        {statuses.map((s) => (
                          <option key={s} value={s}>
                            {spec.statusLabels[s]}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <button
                    className="secondary"
                    onClick={() => void refresh()}
                    disabled={preview || busy}
                  >
                    Refresh
                  </button>
                </div>
                <ToolTable
                  spec={spec}
                  requests={filtered}
                  own={own}
                  onOpen={(request) => {
                    ++detailGeneration.current;
                    selectedRef.current = request.id;
                    setCreating(false);
                    setSelected(request.id);
                    setComment("");
                    setDetailLoading(!preview);
                    setCurrentDetail(
                      preview ? { request, comments: [], activity: [] } : null,
                    );
                    pinDescription(request, tool);
                    setDetailRevision((value) => value + 1);
                  }}
                />
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
                  {filtered.length} shown ·{" "}
                  {preview
                    ? "sample list"
                    : `page ${(desk.page?.index ?? 0) + 1}`}
                  {!preview && (
                    <div>
                      <button
                        className="secondary"
                        disabled={
                          busy || desk.page?.index !== page || page === 0
                        }
                        onClick={() => {
                          invalidateRefresh();
                          setPage((p) => p - 1);
                        }}
                      >
                        Previous page
                      </button>{" "}
                      <button
                        className="secondary"
                        disabled={
                          busy ||
                          desk.page?.index !== page ||
                          !desk.page?.hasMore ||
                          page >= 4000
                        }
                        onClick={() => {
                          invalidateRefresh();
                          setPage((p) => p + 1);
                        }}
                      >
                        Next page
                      </button>
                    </div>
                  )}
                  <span>
                    {preview
                      ? "Read-only preview"
                      : own
                        ? "Only your requests are visible"
                        : `Saved changes refresh every ${Math.round(refreshIntervalMs / 1000)} seconds`}
                  </span>
                </div>
              </section>
              {!preview && member && (
                <CsvTransfer
                  spec={spec}
                  key={member.userId}
                  operates={operates}
                  search={search}
                  status={status}
                  onImported={refresh}
                />
              )}
              <p className="scope-note">
                Shared tool · revision {tool.revision}. Saved records and
                reviewed agent proposals stay in this workspace.
                {!preview && member && (
                  <button
                    className="quiet"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(
                          `${window.location.origin}/w/${desk.workspace?.id || ""}`,
                        )
                        .then(
                          () =>
                            setNotice(
                              "Workspace link copied. Colleagues need workspace access to open it.",
                            ),
                          () =>
                            setError(
                              "Could not copy the workspace link. Copy the address from your browser.",
                            ),
                        );
                    }}
                  >
                    Copy workspace link
                  </button>
                )}
              </p>
            </>
          )}
          {view === "settings" && !preview && operates && member && (
            <details className="advanced-administration">
              <summary>Advanced administration</summary>
              <p className="hint">
                Manage approved sources and inspect saved agent activity.
                Everyday questions belong in your assistant conversation.
              </p>
              {!preview && operates && member && (
                <TeamMemory
                  key={`memory/${desk.workspace?.id}/${member.userId}`}
                  refreshKey={`${desk.workspace?.id}/${tool.revision}/${desk.requests.map((request) => `${request.id}:${request.version}`).join(",")}`}
                />
              )}
              {!preview && operates && member && (
                <TriageWorkspace
                  key={`agent/${desk.workspace?.id}/${member.userId}`}
                  owner={member.role === "owner"}
                  requests={desk.requests}
                  members={desk.members}
                  spec={spec}
                  preferredAgent={companySettings.preferredAgent}
                  onApplied={refresh}
                />
              )}
            </details>
          )}
          {!preview && !member && (
            <section className="empty login">
              <h2>Open the local demo desk</h2>
              <p>
                {showDemoControls
                  ? "Choose a persona above or sign in. "
                  : "Sign in above to use your workspace. "}{" "}
                Owners and operators manage the queue; requesters see their own
                work; viewers have read-only access.
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
                <div className="form-grid">
                  <ToolFields
                    spec={formTool.spec}
                    values={intake}
                    disabled={busy}
                    onChange={setDraft}
                  />
                </div>
                <p className="hint">
                  * Required at intake. Other required details can be clarified
                  before {formTool.spec.statusLabels.ready}.
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
                    <StatusBadge
                      status={detail.request.status}
                      labels={currentDetailTool.spec.statusLabels}
                    />
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
                  {descriptionConflict && (
                    <section
                      className="alert"
                      role="alert"
                      aria-label="Request edit conflict"
                    >
                      <p>
                        <strong>
                          This request changed while you were editing.
                        </strong>{" "}
                        Your draft is preserved. Review saved version{" "}
                        {detail.request.version} before deciding how to
                        continue.
                      </p>
                      <div className="table-scroll">
                        <table>
                          <caption>Current saved values and your draft</caption>
                          <thead>
                            <tr>
                              <th scope="col">Field</th>
                              <th scope="col">Current saved value</th>
                              <th scope="col">Your draft</th>
                            </tr>
                          </thead>
                          <tbody>
                            {descriptionDiff.map((field) => (
                              <tr key={field.id}>
                                <th scope="row">{field.label}</th>
                                <td className="source-text">
                                  {field.saved || "—"}
                                </td>
                                <td className="source-text">
                                  {field.draft || "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <button
                        type="button"
                        disabled={busy || !canWrite}
                        onClick={() => {
                          const baseline = {
                            requestId: detail.request.id,
                            version: detail.request.version,
                            values: descriptionValues(detail.request),
                          };
                          descriptionBaseRef.current = baseline;
                          setDescriptionBase(baseline);
                          setFormTool(currentDetailTool);
                          pendingCommand.current = null;
                          setError(null);
                          setNotice(
                            `Your draft now uses saved version ${detail.request.version}. Review it before saving.`,
                          );
                        }}
                      >
                        Keep my draft with current version
                      </button>{" "}
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() => {
                          pinDescription(detail.request, currentDetailTool);
                          pendingCommand.current = null;
                          setError(null);
                          setNotice(
                            "Latest saved values loaded. Your comment draft is preserved.",
                          );
                        }}
                      >
                        Use latest saved values
                      </button>
                    </section>
                  )}
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
                          customValues: intake.customValues,
                        },
                      });
                    }}
                  >
                    <div className="form-grid">
                      <ToolFields
                        spec={formTool.spec}
                        values={intake}
                        disabled={
                          !canWrite ||
                          busy ||
                          !actionEnabled("edit_description")
                        }
                        onChange={setDraft}
                      />
                    </div>
                    <div className="form-actions">
                      <button
                        type="submit"
                        className="secondary"
                        disabled={
                          !canWrite ||
                          busy ||
                          descriptionConflict ||
                          !actionEnabled("edit_description")
                        }
                      >
                        Save description
                      </button>
                      {descriptionDirty && (
                        <span className="small">
                          Unsaved description · based on version{" "}
                          {descriptionBase?.version}
                        </span>
                      )}
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
                            disabled={
                              !operates || busy || !actionEnabled("set_status")
                            }
                            onChange={(e) =>
                              void command({
                                type: "set_status",
                                status: e.target.value as Status,
                              })
                            }
                          >
                            {statuses.map((s) => (
                              <option key={s} value={s}>
                                {currentDetailTool.spec.statusLabels[s]}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Owner
                          <select
                            value={detail.request.ownerId || ""}
                            disabled={
                              !operates || busy || !actionEnabled("set_owner")
                            }
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
                            disabled={
                              !operates ||
                              busy ||
                              !actionEnabled("set_priority")
                            }
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
                            disabled={
                              !operates ||
                              busy ||
                              !actionEnabled("set_due_date")
                            }
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
                        <button
                          disabled={
                            !canWrite ||
                            busy ||
                            !comment.trim() ||
                            !actionEnabled("add_comment")
                          }
                        >
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
