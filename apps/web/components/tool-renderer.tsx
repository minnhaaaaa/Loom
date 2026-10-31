"use client";
import type {
  AnalyticsResult,
  Intake,
  PublicRequest,
  ToolSpec,
} from "@loom/contracts";
import type { ChangeEvent, CSSProperties } from "react";
import { toolFieldValue, toolRequirements } from "@loom/domain";
import { MetricCard } from "./ui/civitas";

export function ToolFields({
  spec,
  values,
  disabled,
  onChange,
  labelPrefix = "",
}: {
  spec: ToolSpec;
  values: Intake;
  disabled: boolean;
  onChange: (values: Intake) => void;
  labelPrefix?: string;
}) {
  return spec.fields
    .filter((field) => field.visible)
    .map((field) => {
      const input = {
        name: field.id,
        "aria-label": `${labelPrefix}${field.label}`,
        value: toolFieldValue(values, field.id),
        required: field.requiredAt === "intake",
        maxLength: field.maxLength,
        disabled,
        onChange: (
          event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
        ) => {
          const value = event.target.value;
          onChange(
            field.id.startsWith("custom_")
              ? {
                  ...values,
                  customValues: { ...values.customValues, [field.id]: value },
                }
              : { ...values, [field.id]: value },
          );
        },
      };
      return (
        <label
          key={field.id}
          className={field.type === "textarea" ? "wide" : ""}
        >
          {field.label}
          {field.requiredAt === "intake" ? (
            " *"
          ) : (
            <small>
              {field.requiredAt === "ready"
                ? `Required before ${spec.statusLabels.ready}`
                : "Optional"}
            </small>
          )}
          {field.type === "textarea" ? (
            <textarea {...input} rows={4} />
          ) : (
            <input {...input} />
          )}
        </label>
      );
    });
}

function date(value: string | null) {
  return value
    ? new Date(
        value.length === 10 ? `${value}T00:00:00Z` : value,
      ).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      })
    : "No due date";
}

export function ToolTable({
  spec,
  requests,
  own,
  onOpen,
}: {
  spec: ToolSpec;
  requests: PublicRequest[];
  own: boolean;
  onOpen?: (request: PublicRequest) => void;
}) {
  const view = spec.views.find((item) => item.id === "queue")!;
  if (view.id !== "queue") return null;
  const columns = view.columns.filter(
    (id) =>
      !(own && id === "priority") &&
      spec.fields.find((field) => field.id === id)?.visible !== false,
  );
  const labels: Record<string, string> = {
    requesterName: "Requester",
    ownerName: "Owner",
    status: "Status",
    dueAt: "Due",
    priority: "Priority",
    createdAt: "Created",
  };
  function cell(request: PublicRequest, id: string) {
    if (id === "title")
      return (
        <>
          {onOpen ? (
            <button className="request-link" onClick={() => onOpen(request)}>
              {request.title}
            </button>
          ) : (
            <strong>{request.title}</strong>
          )}
          <span className="request-meta">
            {request.requesterName} · Created {date(request.createdAt)}
          </span>
        </>
      );
    if (id === "status")
      return (
        <span className={`status status-${request.status}`}>
          <span aria-hidden="true" />
          {spec.statusLabels[request.status]}
        </span>
      );
    if (id === "ownerName")
      return request.ownerName || <span className="muted">Unassigned</span>;
    if (id === "dueAt" || id === "createdAt") return date(request[id]);
    if (id === "priority")
      return (
        <span className={`priority priority-${request.priority}`}>
          {request.priority}
        </span>
      );
    if (id === "requesterName") return request.requesterName;
    return toolFieldValue(request, id) || <span className="muted">—</span>;
  }
  return (
    <div className="table-scroll">
      <table>
        <caption className="sr-only">
          {own ? "Your requests" : `${spec.title} queue`}
        </caption>
        <thead>
          <tr>
            {columns.map((id) => (
              <th key={id} scope="col">
                {spec.fields.find((field) => field.id === id)?.label ||
                  labels[id]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {requests.map((request) => (
            <tr key={request.id}>
              {columns.map((id) => (
                <td key={id}>{cell(request, id)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ToolSummary({
  spec,
  requests,
  analytics,
}: {
  spec: ToolSpec;
  requests: PublicRequest[];
  analytics: AnalyticsResult | null;
}) {
  const view = spec.views.find((item) => item.id === "summary")!;
  if (view.id !== "summary" || !view.metrics.length) return null;
  const open = requests.filter(
    (request) => !["done", "cancelled"].includes(request.status),
  );
  const customRequirements = spec.fields.some(
    (field) =>
      field.id.startsWith("custom_") && field.requiredAt !== "optional",
  );
  const pageIncomplete = open.filter(
    (request) => toolRequirements(spec, request).length > 0,
  ).length;
  const values = {
    ...(analytics || {
      open: open.length,
      overdue: open.filter(
        (request) =>
          request.dueAt &&
          request.dueAt < new Date().toISOString().slice(0, 10),
      ).length,
      unassigned: open.filter((request) => !request.ownerId).length,
    }),
    incomplete:
      analytics && !customRequirements ? analytics.incomplete : pageIncomplete,
  };
  const labels = {
    open: "Open requests",
    overdue: "Overdue",
    unassigned: "Unassigned",
    incomplete:
      analytics && !customRequirements
        ? "Missing core details"
        : "Missing requirements",
  };
  return (
    <section
      className="stats"
      aria-label="Queue summary"
      style={{ "--summary-count": view.metrics.length } as CSSProperties}
    >
      {view.metrics.map((metric) => (
        <MetricCard
          key={metric}
          label={labels[metric]}
          value={values[metric]}
          detail={
            metric === "incomplete" && analytics && customRequirements
              ? "This page · includes custom requirements"
              : undefined
          }
        />
      ))}
    </section>
  );
}
