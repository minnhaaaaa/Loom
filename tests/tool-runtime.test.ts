import { describe, expect, it } from "vitest";
import {
  dataRequestTemplate,
  intakeSchema,
  type Intake,
  type ToolSpec,
} from "@loom/contracts";
import {
  applyCommand,
  assertToolCommand,
  assertToolValues,
  toolRequirements,
} from "@loom/domain";
import { sampleRequests } from "../packages/contracts/src/fixtures";

function spec(): ToolSpec {
  const value = structuredClone(dataRequestTemplate);
  value.fields.push({
    id: "custom_cost_center",
    label: "Cost center",
    type: "text",
    requiredAt: "ready",
    maxLength: 12,
    visible: true,
  });
  value.fields.push({
    id: "custom_notes",
    label: "Additional notes",
    type: "textarea",
    requiredAt: "optional",
    maxLength: 200,
    visible: true,
  });
  return value;
}
function values(): Intake {
  return {
    title: "Forecast request",
    businessQuestion: "What changed in revenue?",
    reportingPeriod: "October 2026",
    dataset: "Revenue",
    customValues: { custom_cost_center: "FIN-100" },
  };
}

describe("published tool runtime enforcement", () => {
  it("derives missing requirements from published fields and their current labels", () => {
    const intake = values();
    intake.reportingPeriod = "";
    intake.customValues = { custom_cost_center: "   " };
    expect(toolRequirements(spec(), intake)).toEqual([
      "Reporting period",
      "Cost center",
    ]);
    expect(toolRequirements(spec(), values())).toEqual([]);
  });

  it("allows incomplete readiness context at intake and enforces it before progress", () => {
    const incomplete = values();
    incomplete.customValues = {};
    expect(() => assertToolValues(spec(), incomplete)).not.toThrow();
    expect(() => assertToolValues(spec(), incomplete, true)).toThrow(
      "Add Cost center",
    );
    expect(() => assertToolValues(spec(), values(), true)).not.toThrow();
    expect(() =>
      assertToolValues(spec(), { ...values(), title: "   " }),
    ).toThrow("Add Request title");
  });

  it("rejects unknown custom fields and enforces the published per-field limits", () => {
    expect(() =>
      assertToolValues(spec(), {
        ...values(),
        customValues: { custom_unknown: "forged" },
      }),
    ).toThrow("published tool has no field named custom_unknown");
    expect(() =>
      assertToolValues(spec(), {
        ...values(),
        customValues: { custom_cost_center: "x".repeat(13) },
      }),
    ).toThrow("Cost center exceeds its 12-character limit");
  });

  it("bounds custom payload keys, values, count, and encoded size at the contract", () => {
    const parse = (customValues: Record<string, string>) =>
      intakeSchema.safeParse({ ...values(), customValues }).success;
    expect(parse({ [`custom_a${"b".repeat(31)}`]: "valid" })).toBe(true);
    expect(parse({ [`custom_a${"b".repeat(32)}`]: "invalid" })).toBe(false);
    expect(parse({ ownerId: "forged" })).toBe(false);
    expect(parse({ custom_notes: "x".repeat(2001) })).toBe(false);
    expect(
      parse(
        Object.fromEntries(
          Array.from({ length: 9 }, (_, index) => [
            `custom_field_${index}`,
            "x",
          ]),
        ),
      ),
    ).toBe(false);
    expect(
      parse(
        Object.fromEntries(
          Array.from({ length: 8 }, (_, index) => [
            `custom_field_${index}`,
            "x".repeat(1100),
          ]),
        ),
      ),
    ).toBe(false);
  });

  it("checks resulting request state for status and description commands", () => {
    const incomplete = { ...values(), customValues: {}, status: "ready" };
    expect(() =>
      assertToolCommand(
        spec(),
        { type: "set_status", status: "ready" },
        incomplete,
      ),
    ).toThrow("Add Cost center");
    expect(() =>
      assertToolCommand(
        spec(),
        { type: "edit_description", values: incomplete },
        incomplete,
      ),
    ).toThrow("Add Cost center");
    expect(() =>
      assertToolCommand(
        spec(),
        { type: "set_status", status: "needs_info" },
        { ...incomplete, status: "needs_info" },
      ),
    ).not.toThrow();
  });

  it("rejects disabled actions without treating enabled actions as role permissions", () => {
    const published = spec();
    published.actions = published.actions.filter(
      (action) => action !== "request.set_priority",
    );
    expect(() =>
      assertToolCommand(
        published,
        { type: "set_priority", priority: "high" },
        { ...values(), status: "new" },
      ),
    ).toThrow("not available in the published tool");
    const record = sampleRequests[0];
    expect(() =>
      applyCommand(
        { userId: record.requesterId, name: "Requester", role: "requester" },
        record,
        { type: "set_status", status: "done" },
        [],
      ),
    ).toThrow("Only an owner or operator");
  });
});
