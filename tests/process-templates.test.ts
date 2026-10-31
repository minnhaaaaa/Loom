import { describe, expect, it } from "vitest";
import {
  dataRequestTemplate,
  intakeSchema,
  onboardingTemplate,
  processTemplateDraft,
  processTemplates,
  projectReviewTemplate,
  toolCompatibility,
  toolSpecSchema,
} from "@loom/contracts";

describe("team process templates", () => {
  it("uses one validated component and action catalog for each process", () => {
    expect(processTemplates.map((template) => template.id)).toEqual([
      "data",
      "it",
      "onboarding",
      "project-review",
    ]);
    for (const template of processTemplates) {
      expect(toolSpecSchema.safeParse(template.spec).success).toBe(true);
      expect(template.spec.templateId).toBe("request-desk");
      expect(template.spec.actions).toEqual(dataRequestTemplate.actions);
      expect(template.spec.views.map((view) => view.component)).toEqual(
        dataRequestTemplate.views.map((view) => view.component),
      );
      expect(
        toolCompatibility(dataRequestTemplate, template.spec).errors,
      ).toEqual([]);
      for (const values of template.sampleValues) {
        expect(intakeSchema.safeParse(values).success).toBe(true);
        for (const key of Object.keys(values.customValues || {}))
          expect(template.spec.fields.some((field) => field.id === key)).toBe(
            true,
          );
      }
    }
  });

  it("makes onboarding and reviews editable without promising unsupported integrations", () => {
    expect(onboardingTemplate.fields.map((field) => field.label)).toEqual([
      "Employee name",
      "Onboarding plan",
      "Joining date",
      "Team or department",
      "Assigned buddy",
      "Onboarding tasks and progress",
    ]);
    expect(onboardingTemplate.statusLabels.in_progress).toBe("Onboarding");
    expect(projectReviewTemplate.statusLabels.in_progress).toBe("In review");
    expect(onboardingTemplate.fields[5]).toMatchObject({
      type: "textarea",
      requiredAt: "optional",
    });
    const samples = processTemplates.find((item) => item.id === "onboarding")!;
    expect(samples.sampleValues[0].title).toBe("Aarav Shah");
    expect(samples.prompt).toContain("editable text");
  });

  it("switches templates without deleting existing fields, settings, or queue bindings", () => {
    const current = structuredClone(onboardingTemplate);
    const buddy = current.fields.find((field) => field.id === "custom_buddy")!;
    buddy.label = "Confirmed buddy";
    buddy.maxLength = 1000;
    buddy.requiredAt = "ready";
    const before = structuredClone(current);
    const review = processTemplateDraft(current, "project-review");
    expect(current).toEqual(before);
    expect(review.fields.find((field) => field.id === "custom_buddy")).toEqual(
      buddy,
    );
    expect(review.fields.map((field) => field.id)).toEqual([
      "title",
      "businessQuestion",
      "reportingPeriod",
      "dataset",
      "custom_buddy",
      "custom_onboarding_tasks",
      "custom_review_context",
      "custom_review_outcome",
    ]);
    expect(review.views.find((view) => view.id === "queue")!.columns).toContain(
      "custom_buddy",
    );
    expect(toolCompatibility(current, review).errors).toEqual([]);
    const back = processTemplateDraft(review, "data");
    expect(toolCompatibility(review, back).errors).toEqual([]);
    expect(back.fields).toHaveLength(8);
    expect(back.views.find((view) => view.id === "queue")!.columns).toContain(
      "custom_buddy",
    );
  });

  it("rejects field-cap overflow atomically instead of dropping stored fields", () => {
    const current = structuredClone(dataRequestTemplate);
    for (let index = 0; index < 8; index++)
      current.fields.push({
        id: `custom_existing_${index}`,
        label: `Existing field ${index + 1}`,
        type: "text",
        requiredAt: "optional",
        maxLength: 200,
        visible: true,
      });
    const before = structuredClone(current);
    expect(() => processTemplateDraft(current, "onboarding")).toThrow();
    expect(current).toEqual(before);
    expect(processTemplateDraft(current, "it").fields).toHaveLength(12);
  });
});
