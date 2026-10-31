import { describe, expect, it } from "vitest";
import {
  dataRequestTemplate,
  itRequestTemplate,
  toolSpecSchema,
  toolCompatibility,
  toolSpecChanges,
  type ToolSpec,
} from "@loom/contracts";

function template() {
  return structuredClone(dataRequestTemplate);
}
function addField(
  spec: ToolSpec,
  requiredAt: "ready" | "optional" = "optional",
) {
  spec.fields.push({
    id: "custom_cost_center",
    label: "Cost center",
    type: "text",
    requiredAt,
    maxLength: 200,
    visible: true,
  });
  return spec;
}
describe("finite tool specifications", () => {
  it("renders both templates through the same stable request family", () => {
    for (const spec of [dataRequestTemplate, itRequestTemplate])
      expect(toolSpecSchema.safeParse(spec).success).toBe(true);
    expect(itRequestTemplate.templateId).toBe(dataRequestTemplate.templateId);
    expect(itRequestTemplate.fields.map((field) => field.id)).toEqual(
      dataRequestTemplate.fields.map((field) => field.id),
    );
    expect(
      toolCompatibility(dataRequestTemplate, itRequestTemplate).errors,
    ).toEqual([]);
    expect(
      toolSpecChanges(dataRequestTemplate, itRequestTemplate).length,
    ).toBeGreaterThan(0);
  });
  it("rejects executable and unknown descriptors, actions, and reserved field IDs", () => {
    const queue = template().views[0];
    const invalid: unknown[] = [
      { ...template(), expression: "process.env.SECRET" },
      {
        ...template(),
        views: [
          { ...queue, component: "html", html: "<script/>" },
          ...template().views.slice(1),
        ],
      },
      { ...template(), actions: ["database.execute_sql"] },
      {
        ...template(),
        fields: [
          ...template().fields,
          {
            id: "__proto__",
            label: "Bad",
            type: "text",
            requiredAt: "optional",
            maxLength: 100,
            visible: true,
          },
        ],
      },
      {
        ...template(),
        fields: [
          ...template().fields,
          {
            id: "toString",
            label: "Bad",
            type: "text",
            requiredAt: "optional",
            maxLength: 100,
            visible: true,
          },
        ],
      },
    ];
    for (const value of invalid)
      expect(toolSpecSchema.safeParse(value).success).toBe(false);
  });
  it("checks component references, required views, and duplicate keys", () => {
    const cases = [template(), template(), template(), template(), template()];
    const queue = cases[0].views.find((view) => view.id === "queue")!;
    if (queue.id === "queue") queue.columns.push("custom_unknown");
    cases[1].fields.push({ ...cases[1].fields[0] });
    cases[2].views[4] = cases[2].views[0];
    cases[3].actions.push(cases[3].actions[0]);
    const noTitle = cases[4].views.find((view) => view.id === "queue")!;
    if (noTitle.id === "queue") noTitle.columns = ["status"];
    for (const spec of cases)
      expect(toolSpecSchema.safeParse(spec).success).toBe(false);
    const valid = addField(template());
    const validQueue = valid.views.find((view) => view.id === "queue")!;
    if (validQueue.id === "queue")
      validQueue.columns.push("custom_cost_center");
    expect(toolSpecSchema.safeParse(valid).success).toBe(true);
  });
  it("preserves core inputs and bounds extensions rather than executing generated schemas", () => {
    const missing = template();
    missing.fields.shift();
    const hidden = template();
    hidden.fields[0].visible = false;
    const retyped = template();
    retyped.fields[0].type = "textarea";
    const customIntake = addField(template());
    customIntake.fields[4].requiredAt = "intake";
    const oversized = addField(template());
    oversized.fields[4].maxLength = 2001;
    for (const spec of [missing, hidden, retyped, customIntake, oversized])
      expect(toolSpecSchema.safeParse(spec).success).toBe(false);
  });
  it("classifies safe changes and warns about new readiness requirements", () => {
    const next = addField(template(), "ready");
    next.title = "Team requests";
    next.fields[0].label = "Summary";
    const result = toolCompatibility(dataRequestTemplate, next);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("Existing requests"),
    ]);
    expect(toolSpecChanges(dataRequestTemplate, next)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Team requests"),
        expect.stringContaining("Summary"),
        expect.stringContaining("Cost center"),
      ]),
    );
  });
  it("blocks destructive edits, stricter intake, and restoring a revision that loses fields", () => {
    const published = addField(template());
    const restored = toolCompatibility(published, dataRequestTemplate);
    expect(restored.errors).toEqual([
      expect.stringContaining("cannot be removed or renamed"),
    ]);
    for (const change of [
      (spec: ToolSpec) => {
        spec.fields[4].type = "textarea";
      },
      (spec: ToolSpec) => {
        spec.fields[4].maxLength = 20;
      },
      (spec: ToolSpec) => {
        spec.fields[4].requiredAt = "intake";
      },
    ]) {
      const next = structuredClone(published);
      change(next);
      expect(toolCompatibility(published, next).errors).toHaveLength(1);
    }
    const previous = addField(template(), "ready");
    const hidden = structuredClone(previous);
    hidden.fields[4].requiredAt = "optional";
    hidden.fields[4].visible = false;
    expect(toolCompatibility(previous, hidden).errors).toEqual([
      expect.stringContaining("cannot be hidden"),
    ]);
  });
});
