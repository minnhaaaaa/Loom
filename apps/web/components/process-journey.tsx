"use client";

import type { Membership, PublishedTool } from "@loom/contracts";

function reveal(id: string, selector?: string) {
  const target = document.getElementById(id);
  if (!target) return;
  let destination = target;
  if (target instanceof HTMLDetailsElement) target.open = true;
  if (selector) {
    const child = target.querySelector<HTMLDetailsElement>(selector);
    if (child) {
      child.open = true;
      destination = child;
    }
  }
  destination.scrollIntoView({ block: "start" });
  const focusable = destination.querySelector<HTMLElement>(
    "textarea, summary, input, button",
  );
  focusable?.focus({ preventScroll: true });
}

export function ProcessJourney({
  tool,
  membership,
  members,
  preview,
}: {
  tool: PublishedTool;
  membership: Membership | null;
  members: Membership[];
  preview: boolean;
}) {
  const owner = membership?.role === "owner";
  const operates = owner || membership?.role === "operator";
  return (
    <section
      className="process-journey"
      aria-label="From process to shared tool"
    >
      <div className="process-journey-heading">
        <div>
          <p className="eyebrow">A process your team can work in</p>
          <h2>Describe it. Make it shared. Work together.</h2>
        </div>
        <span className="process-journey-label">
          {preview
            ? "Explore with sample data"
            : tool.publishedAt
              ? `Published · revision ${tool.revision}`
              : "Start with a template"}
        </span>
      </div>
      <ol className="process-steps">
        <li>
          <span className="process-step-number" aria-hidden="true">
            1
          </span>
          <div>
            <h3>Describe your process</h3>
            <p>
              Choose a starting point, describe what you need, and review your
              form and views.
            </p>
            <button
              className="quiet"
              disabled={!preview && !owner}
              onClick={() => reveal("tool-builder")}
            >
              {preview ? "Explore the builder" : "Open tool builder"}
            </button>
            {!preview && !owner && (
              <small>Your workspace owner builds and publishes the tool.</small>
            )}
          </div>
        </li>
        <li>
          <span className="process-step-number" aria-hidden="true">
            2
          </span>
          <div>
            <h3>Create a shared tool</h3>
            <p>
              Publish a reviewed draft, invite colleagues, and keep everyone on
              the same records.
            </p>
            <button
              className="quiet"
              disabled={preview || !membership}
              onClick={() =>
                reveal("workspace-access", ".workspace-access-share")
              }
            >
              {owner ? "Invite your team" : "Open workspace access"}
            </button>
            {!preview && membership && (
              <small>
                {members.length} accessible team{" "}
                {members.length === 1 ? "member" : "members"}
              </small>
            )}
          </div>
        </li>
        <li>
          <span className="process-step-number" aria-hidden="true">
            3
          </span>
          <div>
            <h3>Work alongside an agent</h3>
            <p>
              Add approved team knowledge, ask for help, and review the exact
              changes it suggests.
            </p>
            <button
              className="quiet"
              disabled={preview || !operates}
              onClick={() => reveal("agent-workspace", ".agent-run-details")}
            >
              Open agent workspace
            </button>
            {preview && (
              <small>
                Sign in to a connected workspace to share and use the agent.
              </small>
            )}
          </div>
        </li>
      </ol>
    </section>
  );
}
