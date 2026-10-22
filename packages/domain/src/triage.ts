import type { KnowledgeEntry } from "@loom/contracts";
export function activeKnowledge(entry: KnowledgeEntry, day: string) {
  return (
    entry.state === "approved" &&
    entry.effectiveFrom <= day &&
    (!entry.effectiveUntil || entry.effectiveUntil >= day)
  );
}
