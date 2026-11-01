import { expect, it } from "vitest";
import {
  extractDocument,
  splitDocument,
} from "../apps/web/server/document-ingestion";
import { pdfFixture } from "./helpers/pdf";

it("extracts actual PDF text with page provenance, including later pages", async () => {
  const result = await extractDocument(
    pdfFixture([
      "Revenue definitions",
      "Net revenue excludes refunds.",
      "Late-page zebra reconciliation",
    ]),
    "Revenue.pdf",
  );
  expect(result).toMatchObject({
    truncated: false,
    parts: [
      { page: 1, text: "Revenue definitions" },
      { page: 2, text: "Net revenue excludes refunds." },
      { page: 3, text: "Late-page zebra reconciliation" },
    ],
  });
});
it("surfaces corrupt and image-only PDFs instead of saving empty knowledge", async () => {
  await expect(
    extractDocument(new TextEncoder().encode("not a PDF"), "bad.pdf"),
  ).rejects.toThrow("damaged or unsupported");
  await expect(extractDocument(pdfFixture([""]), "scan.pdf")).rejects.toThrow(
    "may need OCR",
  );
  const partial = await extractDocument(
    pdfFixture(["", "Readable page"]),
    "mixed.pdf",
  );
  expect(partial.note).toContain("1 page(s)");
  expect(partial.parts[0].page).toBe(2);
});
it("bounds pages, file size and passage lengths, and exposes truncation", async () => {
  const result = await extractDocument(
    pdfFixture(Array.from({ length: 101 }, (_, i) => `Page ${i + 1}`)),
    "long.pdf",
  );
  expect(result.truncated).toBe(true);
  expect(result.parts.at(-1)?.page).toBe(100);
  await expect(
    extractDocument(new Uint8Array(5_000_001), "large.pdf"),
  ).rejects.toThrow("5 MB");
  const split = splitDocument([{ text: "word ".repeat(100_000), page: 7 }]);
  expect(split.truncated).toBe(true);
  expect(split.parts).toHaveLength(100);
  expect(
    split.parts.every((part) => part.text.length <= 3600 && part.page === 7),
  ).toBe(true);
});
it("chunks text documents beyond the old first-excerpt limit", async () => {
  const text =
    "An ordinary paragraph. ".repeat(230) + " distinctive final definition";
  const result = await extractDocument(
    new TextEncoder().encode(text),
    "Terms.md",
  );
  expect(result.parts.length).toBeGreaterThan(1);
  expect(result.parts.at(-1)?.text).toContain("distinctive final definition");
  expect(result.truncated).toBe(false);
});
