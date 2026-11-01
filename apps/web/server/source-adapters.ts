import "server-only";
import type {
  SourceOption,
  SourceProvider,
  SourceSelection,
} from "@loom/contracts";
import { DomainError } from "@loom/domain";
import {
  downloadDocument,
  graph,
  graphCollection,
  graphUrl,
  object,
  objects,
  plainText,
  slack,
  SourceError,
  string,
  supportedDocument,
} from "./source-transport";

import { extractDocument, type DocumentPart } from "./document-ingestion";
import {
  detectRequest,
  detectionVersion,
  type ChatMessage,
  type RequestDetection,
} from "./request-detection";

export type SourceConfig = {
  rootId: string;
  parentId: string;
  name: string;
  accountId: string;
  requestMode?: "detect" | "all";
};
export type SourceCursor = { next?: string; oldest?: string; latest?: string };
export type SourceItem = {
  id: string;
  title: string;
  text: string;
  url: string;
  author: string;
  updatedAt: string;
  truncated: boolean;
  deleted?: boolean;
  skip?: boolean;
  note?: string;
  parts?: DocumentPart[];
  detection?: Pick<RequestDetection, "decision" | "reason"> & {
    version: string;
  };
};
export type SourcePage = { items: SourceItem[]; cursor: SourceCursor | null };
const enc = encodeURIComponent;
function options(
  items: Record<string, unknown>[],
  field = "displayName",
): SourceOption[] {
  return items
    .filter((item) => string(item.id))
    .map((item) => ({
      id: string(item.id),
      name: string(item[field]) || string(item.id),
    }));
}
export async function sourceOptions(
  token: string,
  provider: SourceProvider,
  parentId = "",
  query = "",
) {
  if (provider === "slack") {
    const channels: Record<string, unknown>[] = [];
    let cursor = "";
    for (let i = 0; i < 10; i++) {
      const page = await slack(token, "conversations.list", {
        types: "public_channel",
        exclude_archived: "true",
        limit: "200",
        ...(cursor ? { cursor } : {}),
      });
      channels.push(
        ...objects(page.channels).filter(
          (c) => !c.is_private && c.is_member !== false,
        ),
      );
      cursor = string(object(page.response_metadata).next_cursor);
      if (!cursor) return options(channels, "name");
    }
    throw new SourceError(
      "Slack has too many channels to list. Limit the app to the intake channels it needs.",
    );
  }
  if (provider === "teams") {
    const list = await graphCollection(
      token,
      parentId
        ? `teams/${enc(parentId)}/channels?$select=id,displayName,membershipType`
        : "me/joinedTeams?$select=id,displayName",
    );
    return options(
      parentId
        ? list.filter((channel) => channel.membershipType === "standard")
        : list,
    );
  }
  if (parentId)
    return options(
      await graphCollection(
        token,
        `sites/${enc(parentId)}/drives?$select=id,name,driveType`,
      ),
      "name",
    );
  if (query.trim().length < 2) return [];
  return options(
    await graphCollection(
      token,
      `sites?search=${enc(query.trim())}&$select=id,displayName`,
    ),
  );
}
export async function validateSource(
  token: string,
  selection: SourceSelection,
  accountId: string,
): Promise<SourceConfig> {
  const { provider, rootId } = selection;
  const parentId = selection.parentId ?? "";
  let name: string;
  if (provider === "slack") {
    const channel = object(
      (await slack(token, "conversations.info", { channel: rootId })).channel,
    );
    if (
      channel.id !== rootId ||
      channel.is_private ||
      channel.is_im ||
      channel.is_mpim ||
      channel.is_archived ||
      channel.is_member === false
    )
      throw new DomainError(
        "SOURCE_SCOPE",
        "Choose a public intake channel that the connected Slack app can read.",
        422,
      );
    name = `#${string(channel.name)}`;
  } else if (provider === "teams") {
    if (!parentId)
      throw new DomainError("SOURCE_SCOPE", "Choose a team first.", 422);
    const channel = await graph(
      token,
      `teams/${enc(parentId)}/channels/${enc(rootId)}`,
    );
    if (channel.id !== rootId || channel.membershipType !== "standard")
      throw new DomainError(
        "SOURCE_SCOPE",
        "Choose a standard Teams intake channel. Private and shared channels are not imported.",
        422,
      );
    name = string(channel.displayName);
  } else {
    if (!parentId)
      throw new DomainError(
        "SOURCE_SCOPE",
        "Choose a SharePoint site first.",
        422,
      );
    const drives = await graphCollection(
      token,
      `sites/${enc(parentId)}/drives?$select=id,name,driveType`,
    );
    const drive = drives.find(
      (value) => value.id === rootId && value.driveType === "documentLibrary",
    );
    if (!drive)
      throw new DomainError(
        "SOURCE_SCOPE",
        "Choose a document library from this SharePoint site.",
        422,
      );
    name = string(drive.name);
  }
  return {
    rootId,
    parentId,
    name: name.slice(0, 160) || provider,
    accountId,
    requestMode: selection.requestMode ?? "detect",
  };
}
function safeLink(value: string, provider: SourceProvider) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SourceError("The source did not return its original link.");
  }
  const valid =
    provider === "slack"
      ? url.hostname.endsWith(".slack.com")
      : provider === "teams"
        ? ["teams.microsoft.com", "teams.cloud.microsoft"].includes(
            url.hostname,
          )
        : url.hostname.endsWith(".sharepoint.com");
  if (
    !valid ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.href.length > 2000
  )
    throw new SourceError("The service returned an invalid source link.");
  return url.href;
}
function item(
  id: string,
  title: string,
  text: string,
  url: string,
  author: string,
  updatedAt: string,
  extra: Partial<SourceItem> = {},
): SourceItem {
  return {
    id,
    title:
      title.replace(/\s+/g, " ").trim().slice(0, 160) || "Untitled request",
    text: text
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
      .slice(0, 3800),
    url,
    author: author.slice(0, 160),
    updatedAt: updatedAt.slice(0, 80),
    truncated: text.length > 3800,
    ...extra,
  };
}
function slackText(value: unknown) {
  return string(value)
    .replace(/<(https?:\/\/[^>|]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
function detectedItem(
  value: SourceItem,
  messages: ChatMessage[],
  config: SourceConfig,
) {
  if (config.requestMode !== "detect") return value;
  const result = detectRequest(messages);
  if (result.evidence) {
    value.title = result.evidence.text
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
    value.author = result.evidence.author.slice(0, 160);
    // Keep the actual ask visible even when it occurs beyond the thread excerpt.
    if (!value.text.includes(result.evidence.text)) {
      value.text =
        `${result.evidence.text.slice(0, 2400)}\n\nThread context:\n${value.text}`.slice(
          0,
          3800,
        );
      value.truncated = true;
    }
  }
  value.detection = {
    decision: result.decision,
    reason: result.reason,
    version: detectionVersion,
  };
  return value;
}
export async function fetchSourcePage(
  provider: SourceProvider,
  token: string,
  config: SourceConfig,
  cursor: SourceCursor | null,
): Promise<SourcePage> {
  if (provider === "slack") {
    // Re-scan a bounded 30-day window, including edits and recently active threads.
    const oldest =
      cursor?.oldest || String(Math.floor(Date.now() / 1000) - 30 * 86400);
    const latest = cursor?.latest || String(Date.now() / 1000);
    const page = await slack(token, "conversations.history", {
      channel: config.rootId,
      oldest,
      latest,
      inclusive: "true",
      limit: "15",
      ...(cursor?.next ? { cursor: cursor.next } : {}),
    });
    const items: SourceItem[] = [];
    for (const message of objects(page.messages)) {
      if (
        message.subtype ||
        message.bot_id ||
        !string(message.user) ||
        !string(message.text) ||
        (message.thread_ts && message.thread_ts !== message.ts)
      )
        continue;
      const id = string(message.ts);
      if (!/^\d+\.\d+$/.test(id)) continue;
      const rootText = slackText(message.text);
      const messages: ChatMessage[] = [
        { id, text: rootText, author: string(message.user) },
      ];
      let text = rootText,
        truncated = false;
      if (Number(message.reply_count) > 0) {
        const replies = await slack(token, "conversations.replies", {
          channel: config.rootId,
          ts: id,
          limit: "100",
        });
        messages.push(
          ...objects(replies.messages)
            .filter(
              (reply) =>
                reply.ts !== id &&
                !reply.bot_id &&
                !reply.subtype &&
                string(reply.user),
            )
            .map((reply) => ({
              id: string(reply.ts),
              text: slackText(reply.text),
              author: string(reply.user),
            })),
        );
        text += objects(replies.messages)
          .filter((reply) => reply.ts !== id && !reply.bot_id && !reply.subtype)
          .map((reply) => `\n\n${string(reply.user)}: ${slackText(reply.text)}`)
          .join("");
        truncated = Boolean(
          replies.has_more ||
          string(object(replies.response_metadata).next_cursor),
        );
      }
      const permalink = await slack(token, "chat.getPermalink", {
        channel: config.rootId,
        message_ts: id,
      });
      items.push(
        detectedItem(
          item(
            id,
            rootText,
            text,
            safeLink(string(permalink.permalink), "slack"),
            string(message.user),
            string(object(message.edited).ts) ||
              string(message.latest_reply) ||
              id,
            { truncated: truncated || text.length > 3800 },
          ),
          messages,
          config,
        ),
      );
    }
    const next = string(object(page.response_metadata).next_cursor);
    if (page.has_more && !next)
      throw new SourceError(
        "Slack did not return the next history page. Sync will retry without skipping it.",
      );
    return { items, cursor: next ? { next, oldest, latest } : null };
  }
  if (provider === "teams") {
    const path = `teams/${enc(config.parentId)}/channels/${enc(config.rootId)}/messages`;
    const page = await graph(
      token,
      cursor?.next || `${path}?$top=20&$expand=replies`,
      path,
    );
    const items: SourceItem[] = [];
    for (const message of objects(page.value)) {
      if (!string(message.id)) continue;
      if (message.deletedDateTime) {
        items.push(
          item(string(message.id), "", "", "", "", "", { deleted: true }),
        );
        continue;
      }
      const user = object(object(message.from).user);
      if (!string(user.id) || message.messageType !== "message") continue;
      const body = object(message.body),
        rootText =
          body.contentType === "html"
            ? plainText(string(body.content))
            : string(body.content);
      if (!rootText.trim()) continue;
      const replies = objects(message.replies).filter(
        (reply) =>
          !reply.deletedDateTime &&
          !!string(object(object(reply.from).user).id),
      );
      const text =
        rootText +
        replies
          .map(
            (reply) =>
              `\n\n${string(object(object(reply.from).user).displayName)}: ${plainText(string(object(reply.body).content))}`,
          )
          .join("");
      items.push(
        detectedItem(
          item(
            string(message.id),
            string(message.subject) || rootText,
            text,
            safeLink(string(message.webUrl), "teams"),
            string(user.displayName),
            string(message.lastModifiedDateTime),
            {
              truncated:
                text.length > 3800 ||
                Boolean(message["replies@odata.nextLink"]),
            },
          ),
          [
            {
              id: string(message.id),
              text: rootText,
              author: string(user.displayName),
            },
            ...replies.map((reply) => ({
              id: string(reply.id),
              text: plainText(string(object(reply.body).content)),
              author: string(object(object(reply.from).user).displayName),
            })),
          ],
          config,
        ),
      );
    }
    const next = string(page["@odata.nextLink"]);
    return { items, cursor: next ? { next: graphUrl(next, path) } : null };
  }
  const path = `drives/${enc(config.rootId)}/root/delta`;
  const page = await graph(token, cursor?.next || `${path}?$top=20`, path);
  const items: SourceItem[] = [];
  for (const file of objects(page.value)) {
    const id = string(file.id),
      name = string(file.name);
    if (!id || file.folder) continue;
    if (file.deleted) {
      items.push(item(id, "", "", "", "", "", { deleted: true }));
      continue;
    }
    if (!file.file) continue;
    if (!supportedDocument(name) || Number(file.size) > 5_000_000) {
      items.push(
        item(id, name, "", "", "", "", {
          skip: true,
          note:
            Number(file.size) > 5_000_000
              ? "File exceeds 5 MB."
              : "Unsupported file type.",
        }),
      );
      continue;
    }
    const data = await downloadDocument(token, config.rootId, id);
    let document;
    try {
      document = await extractDocument(data, name);
    } catch (error) {
      items.push(
        item(id, name, "", "", "", "", {
          skip: true,
          note:
            error instanceof SourceError
              ? error.message
              : "Document could not be read.",
        }),
      );
      continue;
    }
    items.push(
      item(
        id,
        name,
        document.parts[0].text,
        safeLink(string(file.webUrl), "sharepoint"),
        string(object(object(file.lastModifiedBy).user).displayName),
        string(file.lastModifiedDateTime),
        {
          parts: document.parts,
          truncated: document.truncated,
          note: document.note,
        },
      ),
    );
  }
  const next = string(page["@odata.nextLink"]),
    delta = string(page["@odata.deltaLink"]);
  if (!next && !delta)
    throw new SourceError(
      "SharePoint did not return a sync checkpoint. Sync will retry.",
    );
  return {
    items,
    cursor: {
      next: graphUrl(next || delta, path),
      ...(next ? { latest: "paging" } : {}),
    },
  };
}
