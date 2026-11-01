import "server-only";
import { createHash } from "node:crypto";
import type { SourceOption } from "@loom/contracts";
import {
  bytes,
  jsonResponse,
  object,
  objects,
  sourceFetch,
  SourceError,
  string,
} from "./source-transport";
import { extractDocument, splitDocument } from "./document-ingestion";
import type {
  SourceConfig,
  SourceCursor,
  SourceItem,
  SourcePage,
} from "./source-adapters";

const repoName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const sha = /^[a-f0-9]{40}$/;
const fileId = (path: string) =>
  `code:${createHash("sha256").update(path).digest("hex")}`;
const cooldowns = new Map<string, number>();
/** Only constructs read-only requests to GitHub's API, never follows links/redirects. */
export async function github(
  token: string,
  path: string,
  query: Record<string, string> = {},
): Promise<unknown> {
  if (
    !/^(user(?:\/repos)?|repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/(commits|git\/(trees|blobs)\/[a-f0-9]{40}|issues(?:\/\d+\/comments)?))?)$/.test(
      path,
    )
  )
    throw new SourceError("Invalid GitHub resource.");
  const key = createHash("sha256").update(token).digest("hex");
  for (const [id, until] of cooldowns)
    if (until <= Date.now()) cooldowns.delete(id);
  const until = cooldowns.get(key) || 0;
  if (until > Date.now())
    throw new SourceError(
      "GitHub paused sync because of its rate limit. Loom will retry.",
      Math.ceil((until - Date.now()) / 1000),
    );
  const url = new URL(`https://api.github.com/${path}`);
  url.search = new URLSearchParams(query).toString();
  const response = await sourceFetch(url.href, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "Loom",
    },
  });
  if (
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.has("retry-after") ||
        response.headers.get("x-ratelimit-remaining") === "0"))
  ) {
    const seconds = Math.max(
      60,
      Number(response.headers.get("retry-after")) || 0,
      (Number(response.headers.get("x-ratelimit-reset")) || 0) -
        Date.now() / 1000,
    );
    const retry = Number.isFinite(seconds) ? Math.ceil(seconds) : 300;
    cooldowns.set(key, Date.now() + retry * 1000);
    throw new SourceError(
      "GitHub paused sync because of its rate limit. Loom will retry.",
      retry,
    );
  }
  if (!response.ok) {
    await jsonResponse(response);
    throw new SourceError("GitHub is unavailable.");
  }
  try {
    return JSON.parse(Buffer.from(await bytes(response)).toString("utf8"));
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError("GitHub returned an unreadable response.");
  }
}
export async function githubRepository(token: string, id: string) {
  if (!/^\d{1,20}$/.test(id))
    throw new SourceError("Choose a repository from the list.");
  // Resolve a stable ID through documented repository-list/detail endpoints.
  // Looking up the current full name also handles repository renames without following redirects.
  const selected = (await githubOptions(token)).find(
    (entry) => entry.id === id,
  );
  if (!selected)
    throw new SourceError(
      "Repository access is unavailable. Check token approval and selected repositories.",
      900,
      "SOURCE_ACCESS",
    );
  const repo = object(await github(token, `repos/${selected.name}`));
  if (String(repo.id) !== id || !repoName.test(string(repo.full_name)))
    throw new SourceError("GitHub could not verify this repository.");
  return repo;
}
export async function githubOptions(token: string): Promise<SourceOption[]> {
  const options: SourceOption[] = [];
  for (let page = 1; page <= 20; page++) {
    const result = await github(token, "user/repos", {
      per_page: "100",
      page: String(page),
      sort: "full_name",
      direction: "asc",
    });
    if (!Array.isArray(result))
      throw new SourceError("GitHub did not return its repository list.");
    for (const repo of objects(result))
      if (repoName.test(string(repo.full_name)))
        options.push({ id: String(repo.id), name: string(repo.full_name) });
    if (result.length < 100) return options;
  }
  throw new SourceError(
    "Limit your GitHub token to the repositories your team needs.",
  );
}
export function githubFileExclusion(
  path: string,
  mode: string,
  size: number,
): string | null {
  if (!["100644", "100755"].includes(mode))
    return "Symlinks and submodules are not imported.";
  if (
    path.length > 1000 ||
    path.split("/").some((part) => part === ".." || !part)
  )
    return "Unsupported file path.";
  if (
    /(^|\/)(\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|credentials(?:\..*)?|secrets?(?:\..*)?|id_(rsa|dsa|ecdsa|ed25519)|\.aws|\.ssh)(\/|$)|\.(pem|key|p12|pfx|keystore)$/i.test(
      path,
    )
  )
    return "Credential file excluded.";
  if (
    /(^|\/)(node_modules|vendor|dist|build|coverage|\.git|\.next|\.venv|__pycache__)(\/|$)|\.(min\.(js|css)|map|lock)$/i.test(
      path,
    ) ||
    /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(path)
  )
    return "Generated or dependency file excluded.";
  if (!Number.isFinite(size) || size > 262144)
    return "File exceeds the 256 KB import limit.";
  if (
    /\.(png|jpe?g|gif|webp|ico|svgz|mp[34]|mov|wav|zip|gz|tar|woff2?|ttf|otf|exe|dll|so|bin|parquet|sqlite|db)$/i.test(
      path,
    )
  )
    return "Binary asset excluded.";
  return null;
}
export async function githubPage(
  token: string,
  config: SourceConfig,
  cursor: SourceCursor | null,
): Promise<SourcePage> {
  const repo = await githubRepository(token, config.rootId);
  const name = string(repo.full_name),
    base = `repos/${name}`,
    web = `https://github.com/${name}`;
  const state = cursor?.github;
  if (state?.phase === "issues") {
    if (!Number.isSafeInteger(state.page) || state.page < 1)
      throw new SourceError("Invalid GitHub issue checkpoint.");
    const result = await github(token, `${base}/issues`, {
      state: "all",
      sort: "created",
      direction: "asc",
      per_page: "20",
      page: String(state.page),
    });
    if (!Array.isArray(result))
      throw new SourceError("GitHub did not return its issues.");
    const items: SourceItem[] = [];
    for (const issue of objects(result)) {
      const number = Number(issue.number);
      if (
        !Number.isSafeInteger(number) ||
        number < 1 ||
        !Number.isSafeInteger(issue.id)
      )
        throw new SourceError("GitHub returned an invalid issue.");
      const comments =
        Number(issue.comments) > 0
          ? await github(token, `${base}/issues/${number}/comments`, {
              per_page: "100",
              page: "1",
            })
          : [];
      if (!Array.isArray(comments))
        throw new SourceError("GitHub did not return its comments.");
      const text = [
        `${issue.pull_request ? "Pull request" : "Issue"} #${number} · ${string(issue.state)}`,
        string(issue.body),
        ...objects(comments).map(
          (comment) =>
            `${string(object(comment.user).login)}: ${string(comment.body)}`,
        ),
      ].join("\n\n");
      // Repository history is reference context, not a new Loom task backlog.
      const parts = splitDocument([{ text }]);
      items.push({
        id: `issue:${issue.id}`,
        title: `${name} #${number}: ${string(issue.title)}`.slice(0, 160),
        text: text.slice(0, 3800),
        url: `${web}/${issue.pull_request ? "pull" : "issues"}/${number}`,
        author: string(object(issue.user).login).slice(0, 160),
        updatedAt: string(issue.updated_at).slice(0, 80),
        truncated: Number(issue.comments) > 100 || parts.truncated,
        parts: parts.parts,
        note:
          Number(issue.comments) > 100
            ? "Only the first 100 discussion comments were imported."
            : undefined,
      });
    }
    return {
      items,
      cursor:
        result.length === 20
          ? { github: { phase: "issues", page: state.page + 1 } }
          : null,
    };
  }
  let commit = state?.phase === "code" ? state.commit : "";
  let tree = state?.phase === "code" ? state.tree : "";
  const offset = state?.phase === "code" ? state.offset : 0;
  if (!commit) {
    // A single immutable commit is used throughout each code scan.
    const commits = await github(token, `${base}/commits`, {
      per_page: "1",
      sha: string(repo.default_branch),
    });
    if (!Array.isArray(commits) || !commits.length)
      throw new SourceError("This repository has no commits to import yet.");
    const head = object(commits[0]);
    commit = string(head.sha);
    tree = string(object(object(head.commit).tree).sha);
  }
  if (
    !sha.test(commit) ||
    !sha.test(tree) ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new SourceError("Invalid GitHub code checkpoint.");
  const result = object(
    await github(token, `${base}/git/trees/${tree}`, { recursive: "1" }),
  );
  if (result.sha !== tree || !Array.isArray(result.tree) || result.truncated)
    throw new SourceError(
      "GitHub could not return the complete repository tree. Choose a smaller repository.",
    );
  const files = objects(result.tree).filter((entry) => entry.type !== "tree");
  if (files.length > 5000)
    throw new SourceError(
      "This repository exceeds Loom’s 5,000-file import limit.",
    );
  const items: SourceItem[] = [];
  for (const file of files.slice(offset, offset + 20)) {
    const path = string(file.path);
    const input: SourceItem = {
      id: fileId(path),
      title: path.slice(-160),
      text: "",
      url: `${web}/blob/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`,
      author: name.slice(0, 160),
      updatedAt: commit,
      truncated: false,
    };
    const excluded =
      input.url.length > 2000
        ? "File path exceeds the original-link limit."
        : githubFileExclusion(path, string(file.mode), Number(file.size));
    if (excluded) {
      items.push({ ...input, skip: true, note: excluded });
      continue;
    }
    if (!sha.test(string(file.sha)))
      throw new SourceError("GitHub returned an invalid file revision.");
    const blob = object(await github(token, `${base}/git/blobs/${file.sha}`));
    if (
      blob.sha !== file.sha ||
      blob.encoding !== "base64" ||
      Number(blob.size) !== Number(file.size)
    )
      throw new SourceError("GitHub returned an inconsistent file revision.");
    const data = Buffer.from(string(blob.content), "base64");
    if (data.length !== Number(file.size))
      throw new SourceError("GitHub returned an incomplete file.");
    try {
      let extracted;
      if (/\.(pdf|docx)$/i.test(path))
        extracted = await extractDocument(data, path);
      else {
        if (data.includes(0)) throw new SourceError("Binary asset excluded.");
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(data);
        } catch {
          throw new SourceError("File is not UTF-8 text.");
        }
        if (
          /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|(?:ghp_|github_pat_|xox[bp]-)[A-Za-z0-9_-]{20,}/.test(
            text,
          )
        )
          throw new SourceError(
            "Possible credential content excluded. Review the original file.",
          );
        extracted = splitDocument([{ text }]);
      }
      if (!extracted.parts.length) throw new SourceError("Empty file.");
      items.push({ ...input, ...extracted, text: extracted.parts[0].text });
    } catch (error) {
      if (!(error instanceof SourceError)) throw error;
      items.push({ ...input, skip: true, note: error.message });
    }
  }
  const complete = offset + 20 >= files.length;
  return {
    items,
    cursor: complete
      ? { github: { phase: "issues", page: 1 } }
      : { github: { phase: "code", commit, tree, offset: offset + 20 } },
    ...(complete
      ? { reconcileDocuments: files.map((file) => fileId(string(file.path))) }
      : {}),
  };
}
