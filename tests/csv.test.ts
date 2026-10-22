import { describe, expect, it } from "vitest";
import { csvCell, parseCsv, reviewCsv } from "../apps/web/server/csv";
const mapping = {
  title: 0,
  businessQuestion: 1,
  reportingPeriod: 2,
  dataset: 3,
};
describe("bounded CSV review and export", () => {
  it("preserves quoted multiline text, commas, escaped quotes, and UTF-8 BOM", () => {
    const records = parseCsv(
      '\ufefftitle,question,period,dataset\r\n"Revenue, India","Why \"\"now\"\"?\nSecond line",October,Events\r\n',
    );
    const review = reviewCsv(records, mapping);
    expect(review.rows[0].values?.businessQuestion).toBe(
      'Why "now"?\nSecond line',
    );
    expect(review.rows[0].values?.title).toBe("Revenue, India");
    expect(review.rows[0].errors).toEqual([]);
  });
  it("rejects ambiguous headers, malformed columns, oversized records, and files beyond the row cap", () => {
    expect(() => parseCsv("title,title\na,b")).toThrow("unique");
    expect(() => parseCsv("title,question\na,b,c")).toThrow("consistent");
    expect(() => parseCsv('title,question\na,"unterminated')).toThrow(
      "closed quotes",
    );
    expect(() => parseCsv("title,question\na," + "x".repeat(20_001))).toThrow();
    expect(() => parseCsv("title,question\n" + "a,b\n".repeat(101))).toThrow(
      "100",
    );
  });
  it("blocks duplicated mappings/rows and invalid intake; flags missing readiness context", () => {
    const records = parseCsv("title,question\na,Why?\na,Why?\nb,");
    expect(() =>
      reviewCsv(records, {
        ...mapping,
        title: 1,
        reportingPeriod: null,
        dataset: null,
      }),
    ).toThrow("distinct");
    const review = reviewCsv(records, {
      title: 0,
      businessQuestion: 1,
      reportingPeriod: null,
      dataset: null,
    });
    expect(review.rows[0].warnings).toHaveLength(1);
    expect(review.rows[1].errors[0]).toContain("Duplicate");
    expect(review.rows[2].values).toBeNull();
  });
  it("quotes text and neutralizes formula/control prefixes without altering ordinary cells", () => {
    for (const value of [
      "=1+1",
      " +SUM(A1)",
      "\t@evil",
      "\rformula",
      "-2",
      "\u0001=NOW()",
      "\u00a0=1",
    ])
      expect(csvCell(value)).toBe("\"'" + value + '"');
    expect(csvCell('Why "now", India?')).toBe('"Why ""now"", India?"');
    expect(csvCell("normal text")).toBe('"normal text"');
  });
});
