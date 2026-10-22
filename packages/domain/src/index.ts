import type {
  Command,
  Membership,
  RequestRecord,
  Status,
} from "@loom/contracts";

export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 422,
  ) {
    super(message);
  }
}
export function canOperate(member: Membership): boolean {
  return member.role === "owner" || member.role === "operator";
}
export function requireMembership(
  member: Membership | null,
): asserts member is Membership {
  if (!member)
    throw new DomainError(
      "ACCESS_DENIED",
      "You do not have access to this workspace.",
      403,
    );
}
export function assertReadable(
  member: Membership,
  request: RequestRecord,
): void {
  if (member.role === "requester" && request.requesterId !== member.userId)
    throw new DomainError("NOT_FOUND", "Request not found.", 404);
}
export function readiness(
  request: Pick<RequestRecord, "reportingPeriod" | "dataset">,
): string[] {
  return [
    !request.reportingPeriod && "reporting period",
    !request.dataset && "dataset",
  ].filter((v): v is string => Boolean(v));
}
export const transitions: Record<Status, readonly Status[]> = {
  new: ["needs_info", "ready", "cancelled"],
  needs_info: ["new", "ready", "cancelled"],
  ready: ["needs_info", "in_progress", "cancelled"],
  in_progress: ["needs_info", "done", "cancelled"],
  done: ["in_progress"],
  cancelled: ["new"],
};
export function applyCommand(
  member: Membership,
  request: RequestRecord,
  command: Command,
  members: Membership[],
): RequestRecord {
  assertReadable(member, request);
  if (member.role === "viewer")
    throw new DomainError(
      "ACCESS_DENIED",
      "Viewers cannot change requests.",
      403,
    );
  if (
    !canOperate(member) &&
    command.type !== "edit_description" &&
    command.type !== "add_comment"
  )
    throw new DomainError(
      "ACCESS_DENIED",
      "Only an owner or operator can change operational fields.",
      403,
    );
  if (
    command.type === "add_comment" &&
    !canOperate(member) &&
    command.visibility === "internal"
  )
    throw new DomainError(
      "ACCESS_DENIED",
      "Requesters can only add requester-visible comments.",
      403,
    );
  const next = {
    ...request,
    version: request.version + 1,
    updatedAt: new Date().toISOString(),
  };
  switch (command.type) {
    case "set_status":
      if (!transitions[request.status].includes(command.status))
        throw new DomainError(
          "INVALID_TRANSITION",
          "That status change is not allowed.",
        );
      if (
        ["ready", "in_progress", "done"].includes(command.status) &&
        readiness(request).length
      )
        throw new DomainError(
          "MISSING_REQUIREMENTS",
          `Add ${readiness(request).join(" and ")} before moving this request forward.`,
        );
      next.status = command.status;
      break;
    case "set_owner": {
      const owner = members.find(
        (m) => m.userId === command.ownerId && canOperate(m),
      );
      if (command.ownerId && !owner)
        throw new DomainError(
          "INVALID_OWNER",
          "Choose an active owner or operator in this workspace.",
        );
      next.ownerId = command.ownerId;
      next.ownerName = owner?.name ?? null;
      break;
    }
    case "set_priority":
      next.priority = command.priority;
      break;
    case "set_due_date":
      next.dueAt = command.dueAt;
      break;
    case "edit_description":
      Object.assign(next, command.values);
      if (
        ["ready", "in_progress", "done"].includes(next.status) &&
        readiness(next).length
      )
        throw new DomainError(
          "MISSING_REQUIREMENTS",
          "A request at this status must retain its reporting period and dataset.",
        );
      break;
    case "add_comment":
      break;
  }
  return next;
}

export { activeKnowledge } from "./triage";
