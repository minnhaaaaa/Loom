"use client";
import { useRef, useState } from "react";
import { toolSpec } from "@loom/contracts";
import type { CsvMapping } from "@/server/csv";
import type { ImportPreview } from "@/server/imports";
async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.error?.message ||
        "The operation could not be confirmed. Retry to reconcile its saved result.",
    );
  return data as T;
}
const unmapped: CsvMapping = {
  title: null,
  businessQuestion: null,
  reportingPeriod: null,
  dataset: null,
};
export function CsvTransfer({
  operates,
  search,
  status,
  onImported,
}: {
  operates: boolean;
  search: string;
  status: string;
  onImported: () => Promise<void>;
}) {
  const [text, setText] = useState(""),
    [headers, setHeaders] = useState<string[]>([]),
    [mapping, setMapping] = useState<CsvMapping>(unmapped);
  const [preview, setPreview] = useState<ImportPreview | null>(null),
    [busy, setBusy] = useState(false),
    [reviewed, setReviewed] = useState(false),
    [message, setMessage] = useState("");
  const commandId = useRef<string | null>(null);
  async function upload(file?: File) {
    setPreview(null);
    setHeaders([]);
    setText("");
    setReviewed(false);
    commandId.current = null;
    setMessage("");
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setMessage("Choose a CSV no larger than 5 MiB.");
      return;
    }
    setBusy(true);
    try {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(
        await file.arrayBuffer(),
      );
      const data = await post<{ headers: string[] }>("/api/imports/preview", {
        text: content,
      });
      setText(content);
      setHeaders(data.headers);
      setMapping(
        Object.fromEntries(
          toolSpec.fields.map((field) => {
            const index = data.headers.findIndex((h) =>
              [field.id.toLowerCase(), field.label.toLowerCase()].includes(
                h.toLowerCase(),
              ),
            );
            return [field.id, index < 0 ? null : index];
          }),
        ) as CsvMapping,
      );
      setMessage("Choose the column mapping, then generate a preview.");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function review() {
    setBusy(true);
    setMessage("");
    setPreview(null);
    setReviewed(false);
    commandId.current = null;
    try {
      setPreview(
        await post<ImportPreview>("/api/imports/preview", { text, mapping }),
      );
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    if (!preview || !reviewed) return;
    setBusy(true);
    setMessage("");
    commandId.current ??= crypto.randomUUID();
    try {
      const result = await post<{ ids: string[] }>("/api/imports/commit", {
        batchId: preview.batchId,
        previewHash: preview.previewHash,
        commandId: commandId.current,
      });
      setPreview({ ...preview, committedIds: result.ids });
      setMessage(
        `${result.ids.length} requests saved. Repeating this batch will return the same saved records.`,
      );
      await onImported();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(
        `/api/requests/export?${new URLSearchParams({ search, status })}`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error?.message || "Export failed.");
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "loom-requests.csv";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(
        "Export downloaded using the current search, status, and access permissions.",
      );
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="csv-transfer">
      <summary>CSV import / export</summary>
      <p>
        Export up to 500 matching requests across all pages. Spreadsheet
        formulas are escaped for safe viewing.
      </p>
      <button
        className="secondary"
        disabled={busy}
        onClick={() => void download()}
      >
        Export matching CSV
      </button>
      {operates && (
        <>
          <p>
            Import 1–100 rows from a UTF-8 CSV (maximum 5 MiB). All rows must
            pass validation. Each row becomes a request submitted by you, with
            normal priority and no owner or due date. Rows missing dataset or
            reporting period start as Needs information. Other columns are
            ignored.
          </p>
          <label>
            Choose CSV
            <input
              type="file"
              accept=".csv,text/csv"
              disabled={busy}
              onChange={(event) => void upload(event.target.files?.[0])}
            />
          </label>
          {headers.length > 0 && (
            <div className="csv-mapping">
              {toolSpec.fields.map((field) => (
                <label key={field.id}>
                  {field.label}
                  <select
                    disabled={busy}
                    value={mapping[field.id] ?? ""}
                    onChange={(event) => {
                      setMapping({
                        ...mapping,
                        [field.id]:
                          event.target.value === ""
                            ? null
                            : Number(event.target.value),
                      });
                      setPreview(null);
                      setReviewed(false);
                      commandId.current = null;
                    }}
                  >
                    <option value="">Skip column</option>
                    {headers.map((header, index) => (
                      <option key={index} value={index}>
                        {header}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <button disabled={busy} onClick={() => void review()}>
                Generate import preview
              </button>
            </div>
          )}
          {preview && (
            <>
              <p>
                {preview.rows.length} rows ·{" "}
                {preview.rows.filter((row) => row.errors.length).length} invalid
                · preview expires{" "}
                {new Date(preview.expiresAt).toLocaleTimeString()}. Exact
                previously committed files with the same mapping return their
                original records.
              </p>
              <div className="table-scroll">
                <table>
                  <caption>Import review</caption>
                  <thead>
                    <tr>
                      <th>CSV record</th>
                      {toolSpec.fields.map((f) => (
                        <th key={f.id}>{f.label}</th>
                      ))}
                      <th>Validation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row) => (
                      <tr key={row.number}>
                        <td>{row.number}</td>
                        {toolSpec.fields.map((f) => (
                          <td key={f.id}>{row.values?.[f.id] || "—"}</td>
                        ))}
                        <td>
                          {[...row.errors, ...row.warnings].join(" ") ||
                            "Valid · New"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.committedIds ? (
                <p>
                  This batch is already saved ({preview.committedIds.length}{" "}
                  requests).
                </p>
              ) : (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={reviewed}
                      disabled={busy}
                      onChange={(event) => setReviewed(event.target.checked)}
                    />{" "}
                    I reviewed the mapped rows and want to create these
                    requests.
                  </label>
                  <button
                    disabled={
                      busy ||
                      !reviewed ||
                      preview.rows.some((row) => row.errors.length > 0)
                    }
                    onClick={() => void commit()}
                  >
                    Commit reviewed import
                  </button>
                </>
              )}
            </>
          )}
        </>
      )}
      <p role="status" aria-live="polite">
        {busy ? "Working…" : message}
      </p>
    </details>
  );
}
