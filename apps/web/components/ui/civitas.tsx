/**
 * MODIFIED / ADAPTED FOR LOOM from minnhaaaaa/civitas, Apache-2.0.
 * Source commit: 0c914bff3e29a544ea5e9fe53714ad44e55e9743.
 * Sources: apps/web/src/{LandingPage,AuditView,InstallTerminal}.tsx.
 * Changes: extracted stateless presentation primitives, renamed the brand and
 * CSS classes, and parameterized content. See third-party/civitas/README.md
 * and third-party/civitas/LICENSE for provenance and the upstream license.
 */
import type { ReactNode } from "react";
import type { WorkspaceBranding } from "@loom/contracts";

export function CompanyMark({
  branding,
  compact = false,
}: {
  branding: WorkspaceBranding;
  compact?: boolean;
}) {
  const name = branding.companyName.trim() || "Loom";
  return (
    <span
      className={`company-wordmark${compact ? " company-wordmark-compact" : ""}`}
      translate="no"
    >
      {branding.logoDataUrl ? (
        // Uploaded logos are validated, bounded raster data URLs; no remote fetch.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="company-logo"
          src={branding.logoDataUrl}
          alt={`${name} logo`}
        />
      ) : (
        <span className="company-seal" aria-hidden="true">
          {Array.from(name)[0].toUpperCase()}
        </span>
      )}
      <span>{name}</span>
    </span>
  );
}

export function Arrow() {
  return (
    <span className="civitas-arrow" aria-hidden="true">
      ↗
    </span>
  );
}

export function LoomMark() {
  return (
    <span className="civitas-wordmark" translate="no">
      <span className="civitas-seal" aria-hidden="true">
        L
      </span>
      <span>Loom</span>
    </span>
  );
}

export function MetricCard({
  label,
  value,
  detail,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  className?: string;
}) {
  return (
    <div className={["civitas-metric", className].filter(Boolean).join(" ")}>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail != null && <small>{detail}</small>}
    </div>
  );
}

export function ConsoleChrome({
  label,
  status,
}: {
  label: ReactNode;
  status?: ReactNode;
}) {
  return (
    <div className="civitas-console-chrome">
      <span className="civitas-console-lights" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>{label}</span>
      {status != null && <span>{status}</span>}
    </div>
  );
}
