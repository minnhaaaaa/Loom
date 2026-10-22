import { parse } from "csv-parse/sync";
import { intakeSchema, type Intake } from "@loom/contracts";
import { DomainError } from "@loom/domain";
export const csvFields = [
  "title",
  "businessQuestion",
  "reportingPeriod",
  "dataset",
] as const;
export type CsvMapping = Record<(typeof csvFields)[number], number | null>;
export type CsvReview = {
  headers: string[];
  mapping: CsvMapping;
  rows: {
    number: number;
    values: Intake | null;
    errors: string[];
    warnings: string[];
  }[];
};
export function parseCsv(text: string): string[][] {
  if (Buffer.byteLength(text, "utf8") > 5 * 1024 * 1024)
    throw new DomainError(
      "CSV_TOO_LARGE",
      "CSV files must be at most 5 MiB.",
      413,
    );
  let records: string[][];
  try {
    records = parse(text, {
      bom: true,
      skip_empty_lines: true,
      max_record_size: 20_000,
      to: 102,
    });
  } catch {
    throw new DomainError(
      "INVALID_CSV",
      "Use a UTF-8, comma-separated CSV with consistent columns and closed quotes.",
      422,
    );
  }
  if (records.length < 2 || records.length > 101)
    throw new DomainError(
      "CSV_ROW_LIMIT",
      "Include a header and between 1 and 100 data rows per batch.",
      422,
    );
  const headers = records[0].map((h) => h.trim());
  if (
    headers.length > 20 ||
    headers.some((h) => !h || h.length > 160) ||
    new Set(headers).size !== headers.length
  )
    throw new DomainError(
      "CSV_HEADERS",
      "Use 1–20 unique, nonempty column names, each at most 160 characters.",
      422,
    );
  records[0] = headers;
  return records;
}
export function reviewCsv(records: string[][], mapping: CsvMapping): CsvReview {
  const headers = records[0];
  const used = Object.values(mapping).filter((v) => v !== null);
  if (
    mapping.title === null ||
    mapping.businessQuestion === null ||
    used.some((i) => i >= headers.length) ||
    new Set(used).size !== used.length
  )
    throw new DomainError(
      "CSV_MAPPING",
      "Map title and business question to distinct existing columns. Optional fields may be skipped.",
      422,
    );
  const seen = new Set<string>();
  const rows = records.slice(1).map((row, index) => {
    const values = Object.fromEntries(
      csvFields.map((field) => [
        field,
        mapping[field] === null ? "" : row[mapping[field]!],
      ]),
    );
    const parsed = intakeSchema.safeParse(values);
    const errors = parsed.success
      ? []
      : parsed.error.issues.map(
          (issue) => `${issue.path.join(".")}: ${issue.message}`,
        );
    const key = JSON.stringify(parsed.success ? parsed.data : values);
    if (seen.has(key))
      errors.push(
        "Duplicate mapped row in this file. Remove the duplicate before importing.",
      );
    seen.add(key);
    const warnings =
      parsed.success && (!parsed.data.dataset || !parsed.data.reportingPeriod)
        ? ["Missing readiness context; imported as Needs information."]
        : [];
    return {
      number: index + 2,
      values: parsed.success ? parsed.data : null,
      errors,
      warnings,
    };
  });
  return { headers, mapping, rows };
}
// Quote every cell and neutralize formula prefixes, including leading whitespace/control characters.
export function csvCell(input: unknown) {
  const value = String(input ?? "");
  const safe =
    /^[\s\u0000-\u001f\u007f-\u009f]*[=+\-@]/u.test(value) ||
    /^[\t\r\n]/.test(value)
      ? "'" + value
      : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}
