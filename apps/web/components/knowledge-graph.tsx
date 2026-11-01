"use client";

import { useRef, useState } from "react";
import type { MemoryEdge, TeamMemorySnapshot } from "@loom/contracts";
import { LoomSelect } from "./ui/loom-select";

const relations: Record<MemoryEdge["relation"], string> = {
  requested_by: "Requested by",
  assigned_to: "Assigned to",
  owner_context: "Owner context",
  authored_by: "Authored by",
  imported_by: "Imported by",
  approved_by: "Approved by",
  cites: "Cites source",
  proposes_for: "Proposes changes for",
  supersedes: "Replaces",
  learned_from: "Learned from",
};
const kinds = {
  request: "Request",
  person: "Person",
  knowledge: "Knowledge",
  proposal: "Proposal",
};

export function KnowledgeGraph({
  snapshot,
  selected,
  onSelect,
}: {
  snapshot: TeamMemorySnapshot;
  selected: string;
  onSelect: (id: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState({ nodeId: "", index: 0 });
  const { nodes, edges } = snapshot.graph;
  const node =
    nodes.find((item) => item.id === selected) ||
    nodes.find((item) => item.kind === "knowledge") ||
    nodes[0];
  if (!node)
    return (
      <p className="memory-empty">
        Connections appear as your team saves requests and knowledge.
      </p>
    );
  const related = edges
    .filter((edge) => edge.from === node.id || edge.to === node.id)
    .map((edge) => ({
      edge,
      other: nodes.find(
        (item) => item.id === (edge.from === node.id ? edge.to : edge.from),
      ),
    }))
    .filter((item) => item.other !== undefined);
  const lastPage = Math.max(0, Math.ceil(related.length / 6) - 1);
  const index = page.nodeId === node.id ? Math.min(page.index, lastPage) : 0;
  const visible = related.slice(index * 6, index * 6 + 6);
  const source = snapshot.entries.find(
    ({ entry }) => `knowledge:${entry.id}` === node.id,
  )?.entry;
  function choose(id: string) {
    setPage({ nodeId: id, index: 0 });
    onSelect(id);
    root.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus();
  }
  return (
    <div
      ref={root}
      className="knowledge-graph"
      aria-label="Saved relationship map"
    >
      <div className="knowledge-graph-toolbar">
        <LoomSelect
          aria-label="Explore a saved item"
          value={node.id}
          onChange={(event) => choose(event.target.value)}
        >
          {nodes.map((item) => (
            <option key={item.id} value={item.id}>
              {kinds[item.kind]} · {item.label}
            </option>
          ))}
        </LoomSelect>
        <span>
          {related.length} {related.length === 1 ? "connection" : "connections"}
        </span>
      </div>
      <div className="knowledge-graph-canvas">
        <svg
          viewBox="0 0 1000 440"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {visible.map(({ edge }, i) => {
            const left = i % 2 === 0;
            const y = [79.2, 220, 360.8][Math.floor(i / 2)];
            return (
              <path
                key={edge.id}
                d={`M ${left ? 365 : 635} 220 C ${left ? 320 : 680} 220, ${left ? 335 : 665} ${y}, ${left ? 290 : 710} ${y}`}
              />
            );
          })}
        </svg>
        <div className="knowledge-graph-focus" data-kind={node.kind}>
          <span>{kinds[node.kind]}</span>
          <h3 title={node.label}>{node.label}</h3>
          {node.state && <small>{node.state.replaceAll("_", " ")}</small>}
        </div>
        {visible.map(({ edge, other }, i) => (
          <button
            type="button"
            key={edge.id}
            className="knowledge-graph-node"
            data-kind={other!.kind}
            style={{
              left: i % 2 === 0 ? "0%" : "71%",
              top: `${[18, 50, 82][Math.floor(i / 2)]}%`,
            }}
            onClick={() => choose(other!.id)}
            aria-label={`Explore ${other!.label}: ${edge.from === node.id ? "outgoing" : "incoming"} ${relations[edge.relation]}`}
            title={other!.label}
          >
            <span className="knowledge-graph-relation">
              {edge.from === node.id ? "→" : "←"} {relations[edge.relation]}
            </span>
            <strong>{other!.label}</strong>
            <small>{kinds[other!.kind]}</small>
          </button>
        ))}
        {!related.length && (
          <p className="knowledge-graph-empty">No recorded connections yet.</p>
        )}
      </div>
      {lastPage > 0 && (
        <div className="knowledge-graph-pagination">
          <button
            type="button"
            className="quiet"
            disabled={index === 0}
            onClick={() => setPage({ nodeId: node.id, index: index - 1 })}
          >
            Previous
          </button>
          <span>
            {index * 6 + 1}–{Math.min((index + 1) * 6, related.length)} of{" "}
            {related.length}
          </span>
          <button
            type="button"
            className="quiet"
            disabled={index === lastPage}
            onClick={() => setPage({ nodeId: node.id, index: index + 1 })}
          >
            Next
          </button>
        </div>
      )}
      <details className="knowledge-graph-evidence">
        <summary>Details & sources</summary>
        <p>
          {node.label}
          {node.version ? ` · v${node.version}` : ""}
        </p>
        {source && <p className="source-text">{source.content}</p>}
        <p className="hint">
          Arrows follow saved relationships. A citation does not imply approval.
        </p>
        <ul>
          {visible.map(({ edge, other }) => (
            <li key={edge.id}>
              {edge.from === node.id ? node.label : other!.label} →{" "}
              {relations[edge.relation]} →{" "}
              {edge.to === node.id ? node.label : other!.label}
              <small>
                {edge.evidence.source} · {edge.evidence.resourceId} · v
                {edge.evidence.version}
                {edge.evidence.targetVersion
                  ? ` · cited v${edge.evidence.targetVersion}`
                  : ""}
              </small>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
