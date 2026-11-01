import "server-only";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { documentText, SourceError } from "./source-transport";

export type DocumentPart = { text: string; page?: number };
export type ExtractedDocument = {
  parts: DocumentPart[];
  truncated: boolean;
  note?: string;
};
const pdfResult = z.object({
  error: z.enum(["encrypted", "unreadable"]).optional(),
  pages: z
    .array(
      z.object({
        page: z.number().int().positive(),
        text: z.string().max(300_000),
      }),
    )
    .max(100)
    .optional(),
  truncated: z.boolean().optional(),
  pageCount: z.number().int().positive().optional(),
});
export function splitDocument(
  pages: DocumentPart[],
  truncated = false,
): ExtractedDocument {
  const parts: DocumentPart[] = [];
  for (const page of pages) {
    let remaining = page.text
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
      .trim();
    while (remaining) {
      if (parts.length === 100) return { parts, truncated: true };
      let end = Math.min(3600, remaining.length);
      if (end < remaining.length) {
        const boundary = remaining.lastIndexOf(" ", end);
        if (boundary > 2400) end = boundary;
        // Avoid splitting a UTF-16 surrogate pair.
        if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
      }
      parts.push({
        text: remaining.slice(0, end),
        ...(page.page ? { page: page.page } : {}),
      });
      remaining = remaining.slice(end).trimStart();
    }
  }
  return { parts, truncated };
}
export async function extractDocument(
  data: Uint8Array,
  name: string,
): Promise<ExtractedDocument> {
  if (data.length > 5_000_000) throw new SourceError("File exceeds 5 MB.");
  if (!/\.pdf$/i.test(name)) {
    const result = splitDocument([{ text: documentText(data, name) }]);
    if (!result.parts.length) throw new SourceError("No readable text found.");
    return result;
  }
  const script = [
    resolve(process.cwd(), "scripts/extract-pdf.mjs"),
    resolve(process.cwd(), "../../scripts/extract-pdf.mjs"),
  ].find(existsSync);
  if (!script)
    throw new SourceError(
      "PDF parser is missing. Restore scripts/extract-pdf.mjs and retry.",
    );
  const output = await new Promise<string>((accept, reject) => {
    const child = execFile(
      process.execPath,
      ["--max-old-space-size=192", script],
      {
        timeout: 15_000,
        maxBuffer: 2_000_000,
        killSignal: "SIGKILL",
        env: { PATH: process.env.PATH, NODE_ENV: "production" },
      },
      (error, stdout) =>
        error
          ? reject(
              new SourceError(
                "PDF extraction exceeded its time or memory limit.",
              ),
            )
          : accept(stdout),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(data);
  });
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new SourceError("PDF parser returned no readable result.");
  }
  const parsed = pdfResult.safeParse(value);
  if (!parsed.success) throw new SourceError("PDF could not be read.");
  const result = parsed.data;
  if (result.error === "encrypted")
    throw new SourceError("Password-protected PDF. Import an unlocked copy.");
  if (result.error || !result.pages)
    throw new SourceError("PDF is damaged or unsupported.");
  const extracted = splitDocument(
    result.pages.map((page) => ({ text: page.text, page: page.page })),
    result.truncated,
  );
  if (!extracted.parts.length)
    throw new SourceError("No extractable text. This PDF may need OCR.");
  const blank = result.pages.filter((page) => !page.text.trim()).length;
  if (blank)
    extracted.note = `${blank} page(s) have no extractable text; they may need OCR.`;
  return extracted;
}
