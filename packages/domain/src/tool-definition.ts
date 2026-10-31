import type { Command, Intake, ToolSpec } from "@loom/contracts";
import { DomainError } from "./index";

export function toolFieldValue(values: Intake, id: string): string {
  return id.startsWith("custom_")
    ? values.customValues?.[id] || ""
    : String(values[id as keyof Intake] || "");
}

export function toolRequirements(spec: ToolSpec, values: Intake): string[] {
  return spec.fields
    .filter(
      (field) =>
        field.requiredAt !== "optional" &&
        !toolFieldValue(values, field.id).trim(),
    )
    .map((field) => field.label);
}

// These checks supplement role checks; a published action never grants authority.
export function assertToolAction(spec: ToolSpec, action: string) {
  if (!spec.actions.includes(action as ToolSpec["actions"][number]))
    throw new DomainError(
      "TOOL_ACTION_DISABLED",
      "This action is not available in the published tool.",
      422,
    );
}

export function assertToolValues(
  spec: ToolSpec,
  values: Intake,
  ready = false,
) {
  const custom = values.customValues || {};
  for (const id of Object.keys(custom)) {
    if (!spec.fields.some((field) => field.id === id))
      throw new DomainError(
        "UNKNOWN_TOOL_FIELD",
        `The published tool has no field named ${id}. Refresh its definition.`,
        422,
      );
  }
  for (const field of spec.fields) {
    const value = toolFieldValue(values, field.id);
    if (value.length > field.maxLength)
      throw new DomainError(
        "TOOL_FIELD_LIMIT",
        `${field.label} exceeds its ${field.maxLength}-character limit.`,
        422,
      );
    if (
      (field.requiredAt === "intake" ||
        (ready && field.requiredAt === "ready")) &&
      !value.trim()
    )
      throw new DomainError(
        "MISSING_REQUIREMENTS",
        `Add ${field.label} before ${ready ? "moving this request forward" : "saving this request"}.`,
        422,
      );
  }
}

export function assertToolCommand(
  spec: ToolSpec,
  command: Command,
  values: Intake & { status: string },
) {
  assertToolAction(spec, `request.${command.type}`);
  if (command.type === "edit_description" || command.type === "set_status")
    assertToolValues(
      spec,
      values,
      ["ready", "in_progress", "done"].includes(values.status),
    );
}
