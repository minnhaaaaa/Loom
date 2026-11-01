// Runs in a disposable, time- and heap-limited process. No provider credentials
// or document URLs are passed to the parser. PDF scripts are never executed.
console.log = console.warn = () => {};
let document;
let loadingTask;
try {
  const { getDocument } =
    await import("../apps/web/node_modules/pdfjs-dist/legacy/build/pdf.mjs");
  const buffers = [];
  let size = 0;
  for await (const buffer of process.stdin) {
    size += buffer.length;
    if (size > 5_000_000) throw new Error("size");
    buffers.push(buffer);
  }
  loadingTask = getDocument({
    data: new Uint8Array(Buffer.concat(buffers)),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    verbosity: 0,
    stopAtErrors: true,
  });
  document = await loadingTask.promise;
  const pages = [];
  let characters = 0;
  let truncated = document.numPages > 100;
  for (let number = 1; number <= Math.min(100, document.numPages); number++) {
    const page = await document.getPage(number);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) =>
        "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
      )
      .join("")
      .trim();
    const remaining = 300_000 - characters;
    pages.push({ page: number, text: text.slice(0, remaining) });
    characters += text.length;
    page.cleanup();
    if (characters >= 300_000) {
      truncated = true;
      break;
    }
  }
  process.stdout.write(
    JSON.stringify({ pages, truncated, pageCount: document.numPages }),
  );
} catch (error) {
  const errorCode =
    error?.name === "PasswordException" ? "encrypted" : "unreadable";
  process.stdout.write(JSON.stringify({ error: errorCode }));
} finally {
  await loadingTask?.destroy();
}
