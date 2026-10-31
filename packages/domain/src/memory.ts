import type {
  KnowledgeEntry,
  KnowledgeMatch,
  Membership,
  MemoryEdge,
  MemoryNode,
  RequestRecord,
  TriageProposal,
} from "@loom/contracts";
import { activeKnowledge } from "./triage";

function normalized(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en").trim();
}
const stopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "we",
  "with",
  "you",
]);
export function knowledgeQueryTerms(query: string): string[] {
  return [
    ...new Set(
      normalized(query)
        .slice(0, 4000)
        .match(/[\p{L}\p{N}_-]+/gu) || [],
    ),
  ]
    .filter((token) => token.length > 1 && !stopWords.has(token))
    .slice(0, 128);
}

/** Deterministic lexical ranking. Scores express match strength, not confidence. */
export function retrieveKnowledge(
  entries: KnowledgeEntry[],
  query: string,
  options: {
    workspaceId?: string;
    dataset?: string;
    ownerId?: string;
    kind?: KnowledgeEntry["kind"];
    asOf?: string;
    limit?: number;
  } = {},
): KnowledgeMatch[] {
  const asOf = options.asOf || new Date().toISOString().slice(0, 10);
  const text = normalized(query).slice(0, 4000);
  const tokens = knowledgeQueryTerms(text);
  const limit = Math.max(1, Math.min(20, Math.floor(options.limit || 8)));
  const results: KnowledgeMatch[] = [];
  for (const entry of entries) {
    if (
      (options.workspaceId && entry.workspaceId !== options.workspaceId) ||
      !activeKnowledge(entry, asOf) ||
      (options.dataset &&
        normalized(entry.dataset) !== normalized(options.dataset)) ||
      (options.ownerId && entry.ownerId !== options.ownerId) ||
      (options.kind && entry.kind !== options.kind)
    )
      continue;
    const title = normalized(entry.title),
      content = normalized(entry.content),
      dataset = normalized(entry.dataset);
    let score = 0;
    const matchedBy: KnowledgeMatch["matchedBy"] = [];
    if (!text) matchedBy.push("recent");
    else {
      if (entry.id.toLowerCase() === text || title === text) {
        score += 1000;
        matchedBy.push("exact");
      }
      const matches = tokens.filter(
        (token) =>
          title.includes(token) ||
          content.includes(token) ||
          dataset.includes(token),
      );
      if (matches.length) {
        score += matches.reduce(
          (sum, token) =>
            sum +
            (title.includes(token) ? 8 : 0) +
            (content.includes(token) ? 2 : 0) +
            (dataset.includes(token) ? 6 : 0),
          0,
        );
        matchedBy.push("keyword");
      }
      if (dataset === text || entry.ownerId?.toLowerCase() === text) {
        score += 30;
        matchedBy.push("metadata");
      }
      if (!score) continue;
    }
    if (options.dataset || options.ownerId || options.kind)
      matchedBy.push("metadata");
    results.push({ entry, score, matchedBy: [...new Set(matchedBy)] });
  }
  return results
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.entry.createdAt.localeCompare(left.entry.createdAt) ||
        left.entry.id.localeCompare(right.entry.id),
    )
    .slice(0, limit);
}

/** A bounded projection of stored facts; citations are claims of use, not truth. */
export function buildMemoryGraph(input: {
  workspaceId: string;
  requests: RequestRecord[];
  members: Membership[];
  knowledge: KnowledgeEntry[];
  proposals: TriageProposal[];
}): { nodes: MemoryNode[]; edges: MemoryEdge[] } {
  const nodes = new Map<string, MemoryNode>();
  const edges: MemoryEdge[] = [];
  const addEdge = (
    from: string,
    to: string,
    relation: MemoryEdge["relation"],
    evidence: MemoryEdge["evidence"],
  ) => {
    if (!nodes.has(from) || !nodes.has(to)) return;
    edges.push({
      id: `${from}/${relation}/${to}`,
      from,
      to,
      relation,
      evidence,
    });
  };
  const persons = new Map(
    input.members.slice(0, 100).map((member) => [member.userId, member]),
  );
  const addPerson = (id: string) => {
    const member = persons.get(id);
    if (member)
      nodes.set(`person:${id}`, {
        id: `person:${id}`,
        kind: "person",
        label: member.name,
        state: member.role,
      });
  };
  const requests = input.requests
    .filter((entry) => entry.workspaceId === input.workspaceId)
    .slice(0, 50);
  const knowledge = input.knowledge
    .filter((entry) => entry.workspaceId === input.workspaceId)
    .slice(0, 20);
  const proposals = input.proposals
    .filter((entry) => entry.content.workspaceId === input.workspaceId)
    .slice(0, 50);
  for (const request of requests) {
    nodes.set(`request:${request.id}`, {
      id: `request:${request.id}`,
      kind: "request",
      label: request.title,
      version: request.version,
      state: request.status,
    });
    addPerson(request.requesterId);
    if (request.ownerId) addPerson(request.ownerId);
  }
  for (const entry of knowledge) {
    nodes.set(`knowledge:${entry.id}`, {
      id: `knowledge:${entry.id}`,
      kind: "knowledge",
      label: entry.title,
      version: entry.version,
      state: entry.state,
    });
    if (entry.ownerId) addPerson(entry.ownerId);
    addPerson(entry.createdBy);
    if (entry.approvedBy) addPerson(entry.approvedBy);
  }
  for (const proposal of proposals)
    nodes.set(`proposal:${proposal.content.id}`, {
      id: `proposal:${proposal.content.id}`,
      kind: "proposal",
      label: "Agent proposal",
      version: proposal.content.revision,
      state: proposal.state,
    });
  for (const request of requests) {
    const evidence: MemoryEdge["evidence"] = {
      resourceId: request.id,
      version: request.version,
      source: "request-record",
    };
    addEdge(
      `request:${request.id}`,
      `person:${request.requesterId}`,
      "requested_by",
      evidence,
    );
    if (request.ownerId)
      addEdge(
        `request:${request.id}`,
        `person:${request.ownerId}`,
        "assigned_to",
        evidence,
      );
  }
  for (const entry of knowledge) {
    const evidence: MemoryEdge["evidence"] = {
      resourceId: entry.id,
      version: entry.version,
      source: "knowledge-record",
    };
    if (entry.ownerId)
      addEdge(
        `knowledge:${entry.id}`,
        `person:${entry.ownerId}`,
        "owner_context",
        evidence,
      );
    addEdge(
      `knowledge:${entry.id}`,
      `person:${entry.createdBy}`,
      "authored_by",
      evidence,
    );
    if (entry.approvedBy)
      addEdge(
        `knowledge:${entry.id}`,
        `person:${entry.approvedBy}`,
        "approved_by",
        evidence,
      );
    if (entry.supersedesId)
      addEdge(
        `knowledge:${entry.id}`,
        `knowledge:${entry.supersedesId}`,
        "supersedes",
        evidence,
      );
    if (entry.provenance)
      addEdge(
        `knowledge:${entry.id}`,
        `proposal:${entry.provenance.proposalId}`,
        "learned_from",
        evidence,
      );
  }
  for (const { content } of proposals) {
    const evidence: MemoryEdge["evidence"] = {
      resourceId: content.id,
      version: content.revision,
      source: "proposal-record",
    };
    addEdge(
      `proposal:${content.id}`,
      `request:${content.requestId}`,
      "proposes_for",
      evidence,
    );
    for (const cited of content.evidence)
      addEdge(`proposal:${content.id}`, `knowledge:${cited.id}`, "cites", {
        ...evidence,
        targetVersion: cited.version,
      });
  }
  return { nodes: [...nodes.values()], edges };
}
