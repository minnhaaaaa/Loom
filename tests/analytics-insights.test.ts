import { describe, expect, it } from "vitest";
import { flowInsightsSql, insightWindow } from "@loom/analytics";
import { insightQuerySchema } from "@loom/contracts";

describe("analytics window boundaries", () => {
  it("uses exact rolling UTC days and includes partial ISO weeks across a year boundary", () => {
    const window = insightWindow(30, new Date("2027-01-01T12:34:56.789Z"));
    expect(window.from).toBe("2026-12-02T12:34:56.789Z");
    expect(window.asOf).toBe("2027-01-01T12:34:56.789Z");
    expect(window.weeks).toEqual([
      "2026-11-30",
      "2026-12-07",
      "2026-12-14",
      "2026-12-21",
      "2026-12-28",
    ]);
  });
  it("excludes a week beginning exactly at the cutoff and bounds the 90-day window", () => {
    expect(
      insightWindow(30, new Date("2026-11-02T00:00:00Z")).weeks.at(-1),
    ).toBe("2026-10-26");
    expect(
      insightWindow(90, new Date("2026-11-01T23:59:59Z")).weeks,
    ).toHaveLength(13);
    expect(() => flowInsightsSql(15)).toThrow();
    expect(() => flowInsightsSql(1.5)).toThrow();
  });
  it("accepts only supported periods and rejects ignored historical or cross-workspace filters", () => {
    expect(insightQuerySchema.parse({})).toEqual({ days: 30 });
    for (const input of [
      { days: 7 },
      { days: "90" },
      { days: 30, asOf: "2025-01-01" },
      { workspaceId: "another" },
    ])
      expect(insightQuerySchema.safeParse(input).success).toBe(false);
  });
});
