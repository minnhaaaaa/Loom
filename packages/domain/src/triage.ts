import type {
  Command,
  KnowledgeEntry,
  Membership,
  RequestRecord,
} from "@loom/contracts";
import { applyCommand, canOperate, readiness } from "./index";
export function activeKnowledge(entry: KnowledgeEntry, day: string) {
  return (
    entry.state === "approved" &&
    entry.effectiveFrom <= day &&
    (!entry.effectiveUntil || entry.effectiveUntil >= day)
  );
}
export function routingKey(dataset: string) {
  return dataset.trim().toLowerCase();
}
export function triageRequest(
  request: RequestRecord,
  rules: KnowledgeEntry[],
  members: Membership[],
  day: string,
) {
  const commands: Command[] = [],
    reasons: string[] = [],
    uncertainty: string[] = [];
  const evidence: KnowledgeEntry[] = [];
  if (["done", "cancelled"].includes(request.status))
    return {
      commands,
      reasons: ["Closed request; no changes proposed."],
      uncertainty,
      evidence,
      after: request,
    };
  const missing = readiness(request);
  if (missing.length) {
    commands.push({
      type: "add_comment",
      visibility: "internal",
      body: `Clarification draft — not sent: Please provide ${missing.join(" and ")} so the team can assess this request.`,
    });
    if (request.status === "new")
      commands.push({ type: "set_status", status: "needs_info" });
    reasons.push(
      `Required readiness context is missing: ${missing.join(", ")}.`,
    );
  }
  if (!request.ownerId) {
    const candidates = rules.filter(
      (rule) =>
        rule.kind === "routing" &&
        routingKey(rule.dataset) === routingKey(request.dataset) &&
        activeKnowledge(rule, day),
    );
    if (!request.dataset)
      uncertainty.push("No owner suggestion: dataset is missing.");
    else if (!candidates.length)
      uncertainty.push(
        "No owner suggestion: no active approved exact-dataset routing rule.",
      );
    else if (new Set(candidates.map((rule) => rule.ownerId)).size !== 1)
      uncertainty.push(
        "Conflicting approved routing rules; clarify with an owner before assigning.",
      );
    else {
      const owner = members.find(
        (member) =>
          member.userId === candidates[0].ownerId && canOperate(member),
      );
      if (!owner)
        uncertainty.push(
          "The routing rule names an owner who is no longer eligible.",
        );
      else {
        commands.push({ type: "set_owner", ownerId: owner.userId });
        evidence.push(...candidates);
        reasons.push(
          `Active approved exact-dataset routing rules assign this work to ${owner.name}.`,
        );
      }
    }
  }
  // No source prose or request text is interpreted as instructions or executable actions.
  let after = request;
  const operator: Membership = {
    userId: request.requesterId,
    name: "Rule baseline",
    role: "operator",
  };
  for (const command of commands)
    after = applyCommand(operator, after, command, members);
  return { commands, reasons, uncertainty, evidence, after };
}
