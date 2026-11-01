import "server-only";
import { z } from "zod";
import { DomainError } from "@loom/domain";
import { strFromU8, unzipSync } from "fflate";

export type Json = Record<string, unknown>;
export function object(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
}
export function objects(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(object) : [];
}
export function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
export class SourceError extends DomainError {
  constructor(
    message: string,
    public retrySeconds = 300,
    code = "SOURCE_UNAVAILABLE",
  ) {
    super(code, message, 502);
  }
}
export async function bytes(
  response: Response,
  limit = 4_000_000,
): Promise<Uint8Array> {
  if (!response.body || Number(response.headers.get("content-length")) > limit)
    throw new SourceError("The source response is too large to import.");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > limit) {
        await reader.cancel();
        throw new SourceError("The source response is too large to import.");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
export async function sourceFetch(url: string, init: RequestInit = {}) {
  try {
    return await fetch(url, {
      ...init,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new SourceError(
      "Could not reach the connected service. Loom will retry.",
    );
  }
}
export async function jsonResponse(response: Response): Promise<Json> {
  if (response.status === 429) {
    const seconds = Number(response.headers.get("retry-after"));
    throw new SourceError(
      "The service paused sync because of its rate limit. Loom will retry.",
      Number.isFinite(seconds) ? Math.min(86400, Math.max(60, seconds)) : 300,
    );
  }
  if (!response.ok) {
    if ([401, 403].includes(response.status))
      throw new SourceError(
        "Access expired or permission is missing. Reconnect the service or check the selected source.",
        900,
        "SOURCE_ACCESS",
      );
    if (response.status === 410)
      throw new SourceError(
        "The sync cursor expired. Pause and resume this source to scan it again.",
        900,
        "SOURCE_CURSOR_EXPIRED",
      );
    throw new SourceError(
      "The service could not return this source. Check its availability and permissions.",
    );
  }
  try {
    return object(
      JSON.parse(Buffer.from(await bytes(response)).toString("utf8")),
    );
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError("The service returned an unreadable response.");
  }
}
export async function slack(
  token: string,
  method: string,
  values: Record<string, string> = {},
) {
  const url = new URL(`https://slack.com/api/${method}`);
  url.search = new URLSearchParams(values).toString();
  const body = await jsonResponse(
    await sourceFetch(url.href, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
  if (body.ok !== true) {
    const code = string(body.error);
    if (code === "ratelimited")
      throw new SourceError(
        "Slack paused sync because of its rate limit. Loom will retry.",
        300,
      );
    throw new SourceError(
      ["missing_scope", "not_allowed_token_type"].includes(code)
        ? "The Slack token needs channels:read and channels:history, including permission to read thread replies."
        : "Slack access is unavailable. Check the app token and invite the app to the selected channel.",
      900,
      "SOURCE_ACCESS",
    );
  }
  return body;
}
export function graphUrl(path: string, expectedPath?: string) {
  const url = new URL(path, "https://graph.microsoft.com/v1.0/");
  if (
    url.origin !== "https://graph.microsoft.com" ||
    url.username ||
    url.password ||
    !url.pathname.startsWith("/v1.0/") ||
    (expectedPath &&
      url.pathname !==
        new URL(expectedPath, "https://graph.microsoft.com/v1.0/").pathname)
  )
    throw new SourceError(
      "The service returned an invalid pagination address.",
    );
  return url.href;
}
export async function graph(
  token: string,
  path: string,
  expectedPath?: string,
) {
  return jsonResponse(
    await sourceFetch(graphUrl(path, expectedPath), {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}
export async function graphCollection(token: string, path: string) {
  const result: Json[] = [];
  let next = graphUrl(path);
  for (let page = 0; page < 10 && next; page++) {
    const response = await graph(token, next, path);
    result.push(...objects(response.value));
    next = string(response["@odata.nextLink"]);
  }
  if (next)
    throw new SourceError(
      "This list is too large. Narrow the SharePoint site search or choose a smaller team.",
    );
  return result;
}
export const microsoftScopes =
  "offline_access User.Read Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Read.All Sites.Read.All";
export function microsoftConfiguration() {
  const clientId = process.env.LOOM_MICROSOFT_CLIENT_ID || "";
  const tenantId = process.env.LOOM_MICROSOFT_TENANT_ID || "";
  if (
    !z.uuid().safeParse(clientId).success ||
    !z.uuid().safeParse(tenantId).success
  )
    throw new DomainError(
      "MICROSOFT_SETUP",
      "Set LOOM_MICROSOFT_CLIENT_ID and LOOM_MICROSOFT_TENANT_ID for your Microsoft app, then restart Loom.",
      503,
    );
  return {
    clientId,
    tenantId,
    endpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0`,
  };
}
export async function microsoftForm(
  path: "devicecode" | "token",
  values: Record<string, string>,
) {
  const config = microsoftConfiguration();
  const response = await sourceFetch(`${config.endpoint}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      ...values,
    }).toString(),
  });
  if (response.status === 429) return jsonResponse(response);
  let body: Json;
  try {
    body = object(
      JSON.parse(Buffer.from(await bytes(response, 64_000)).toString("utf8")),
    );
  } catch {
    throw new SourceError("Microsoft returned an unreadable sign-in response.");
  }
  // The device protocol reports pending/expired consent with HTTP 400.
  if (!response.ok && !body.error)
    throw new SourceError("Microsoft sign-in is unavailable.");
  return body;
}
export function plainText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|li|tr)>|<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(
      /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
      (whole, code: string) => {
        const names: Record<string, string> = {
          amp: "&",
          lt: "<",
          gt: ">",
          quot: '"',
          apos: "'",
          nbsp: " ",
        };
        if (code[0] !== "#") return names[code.toLowerCase()] || whole;
        const point =
          code[1].toLowerCase() === "x"
            ? parseInt(code.slice(2), 16)
            : Number(code.slice(1));
        return point > 0 && point <= 0x10ffff
          ? String.fromCodePoint(point)
          : "";
      },
    )
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
export const supportedDocument = (name: string) =>
  /\.(txt|md|markdown|html?|docx)$/i.test(name);
export function documentText(data: Uint8Array, name: string) {
  if (/\.docx$/i.test(name)) {
    const files = unzipSync(data, {
      filter: (entry) =>
        entry.name === "word/document.xml" && entry.originalSize <= 8_000_000,
    });
    if (!files["word/document.xml"])
      throw new SourceError(
        "This Word document is too large or could not be read.",
      );
    return plainText(
      strFromU8(files["word/document.xml"]).replace(/<\/w:p>/g, "\n"),
    );
  }
  const text = strFromU8(data);
  return /\.html?$/i.test(name) ? plainText(text) : text.trim();
}
export async function downloadDocument(
  token: string,
  driveId: string,
  itemId: string,
) {
  let response = await sourceFetch(
    graphUrl(
      `drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`,
    ),
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (response.status === 302) {
    const url = new URL(
      response.headers.get("location") || "https://invalid.invalid",
    );
    if (
      url.protocol !== "https:" ||
      !url.hostname.endsWith(".sharepoint.com") ||
      url.port ||
      url.username ||
      url.password
    )
      throw new SourceError(
        "SharePoint returned an unsupported download address.",
      );
    // Pre-authenticated SharePoint download: never forward the Graph token.
    response = await sourceFetch(url.href);
  }
  if (!response.ok) await jsonResponse(response);
  return bytes(response, 5_000_000);
}
