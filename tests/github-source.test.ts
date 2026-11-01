import { afterEach, expect, it, vi } from "vitest";
import {
  github,
  githubFileExclusion,
  githubOptions,
  githubPage,
} from "../apps/web/server/github-source";
import { validateSource } from "../apps/web/server/source-adapters";
const commit = "a".repeat(40),
  tree = "b".repeat(40),
  blob = "c".repeat(40);
const config = {
  rootId: "123",
  parentId: "",
  name: "acme/analytics",
  accountId: "42",
};
const content = "SELECT SUM(net_revenue) FROM orders;";
const entry = (path = "src/revenue.sql") => ({
  path,
  mode: "100644",
  type: "blob",
  size: Buffer.byteLength(content),
  sha: blob,
});
function mock(files = [entry()], overrides: Record<string, unknown> = {}) {
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    expect(url.origin).toBe("https://api.github.com");
    expect(init?.redirect).toBe("manual");
    expect(init?.method ?? "GET").toBe("GET");
    const responses: Record<string, unknown> = {
      "/user/repos": [{ id: 123, full_name: "acme/analytics" }],
      "/repos/acme/analytics": {
        id: 123,
        full_name: "acme/analytics",
        default_branch: "main",
      },
      "/repos/acme/analytics/commits": [
        { sha: commit, commit: { tree: { sha: tree } } },
      ],
      [`/repos/acme/analytics/git/trees/${tree}`]: {
        sha: tree,
        tree: files,
        truncated: false,
      },
      [`/repos/acme/analytics/git/blobs/${blob}`]: {
        sha: blob,
        size: Buffer.byteLength(content),
        encoding: "base64",
        content: Buffer.from(content).toString("base64"),
      },
      ...overrides,
    };
    if (!(url.pathname in responses))
      throw new Error(`Unexpected route ${url.pathname}`);
    return Response.json(responses[url.pathname]);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
afterEach(() => vi.unstubAllGlobals());
it("imports source code as cited passages pinned to one commit", async () => {
  mock();
  const page = await githubPage("synthetic", config, null);
  expect(page.items[0]).toMatchObject({
    title: "src/revenue.sql",
    parts: [{ text: content }],
    url: `https://github.com/acme/analytics/blob/${commit}/src/revenue.sql`,
    updatedAt: commit,
  });
  expect(page.reconcileDocuments).toEqual([page.items[0].id]);
  expect(page.cursor).toEqual({ github: { phase: "issues", page: 1 } });
});
it("continues the same immutable revision across pages and reconciles only the complete tree", async () => {
  const fetch = mock(
    Array.from({ length: 21 }, (_, index) => entry(`src/${index}.sql`)),
  );
  const first = await githubPage("synthetic", config, null);
  expect(first.items).toHaveLength(20);
  expect(first.reconcileDocuments).toBeUndefined();
  const second = await githubPage("synthetic", config, first.cursor);
  expect(second.items).toHaveLength(1);
  expect(second.reconcileDocuments).toHaveLength(21);
  expect(
    fetch.mock.calls.filter(([url]) => url.includes("/commits?")),
  ).toHaveLength(1);
});
it("never treats an incomplete tree as a complete scan", async () => {
  mock([], {
    [`/repos/acme/analytics/git/trees/${tree}`]: {
      sha: tree,
      tree: [],
      truncated: true,
    },
  });
  await expect(githubPage("synthetic", config, null)).rejects.toThrow(
    "complete repository tree",
  );
});
it("skips credential, generated, binary and symlink files before requesting content", async () => {
  const fetch = mock([
    entry(".env.production"),
    entry("node_modules/pkg/index.js"),
    entry("assets/logo.png"),
    { ...entry("external"), mode: "120000" },
  ]);
  const page = await githubPage("synthetic", config, null);
  expect(page.items.every((item) => item.skip)).toBe(true);
  expect(fetch.mock.calls.some(([url]) => url.includes("/blobs/"))).toBe(false);
  expect(githubFileExclusion("src/big.ts", "100644", 300000)).toMatch(/256 KB/);
});
it("does not import a hidden private key in an otherwise ordinary text file", async () => {
  const text = "-----BEGIN RSA PRIVATE KEY-----\nnot-real";
  mock([{ ...entry(), size: Buffer.byteLength(text) }], {
    [`/repos/acme/analytics/git/blobs/${blob}`]: {
      sha: blob,
      size: Buffer.byteLength(text),
      encoding: "base64",
      content: Buffer.from(text).toString("base64"),
    },
  });
  const page = await githubPage("synthetic", config, null);
  expect(page.items[0]).toMatchObject({
    skip: true,
    text: "",
    note: "Possible credential content excluded. Review the original file.",
  });
});
it("imports closed issues and pull requests with comments as knowledge context", async () => {
  mock([], {
    "/repos/acme/analytics/issues": [
      {
        id: 12,
        number: 2,
        title: "Explain refunds",
        state: "closed",
        body: "Exclude refunded orders.",
        comments: 101,
        pull_request: {},
        user: { login: "analyst" },
        updated_at: "2026-11-01T00:00:00Z",
      },
    ],
    "/repos/acme/analytics/issues/2/comments": [
      { user: { login: "reviewer" }, body: "Use the finance definition." },
    ],
  });
  const page = await githubPage("synthetic", config, {
    github: { phase: "issues", page: 1 },
  });
  expect(page.items[0]).toMatchObject({
    id: "issue:12",
    url: "https://github.com/acme/analytics/pull/2",
    truncated: true,
  });
  expect(page.items[0].parts?.[0].text).toContain(
    "reviewer: Use the finance definition.",
  );
  expect(page.cursor).toBeNull();
});
it("validates repository identity rather than trusting a submitted name", async () => {
  mock([], {
    "/repos/acme/analytics": { id: 456, full_name: "other/private" },
  });
  await expect(
    validateSource(
      "synthetic",
      { provider: "github", rootId: "123", shareWithWorkspace: true },
      "42",
    ),
  ).rejects.toThrow("verify");
});
it("rejects off-origin routes and respects GitHub's retry delay", async () => {
  const fetch = vi.fn(
    async () =>
      new Response("", { status: 403, headers: { "retry-after": "120" } }),
  );
  vi.stubGlobal("fetch", fetch);
  await expect(github("rate-test", "https://evil.test/user")).rejects.toThrow(
    "Invalid",
  );
  await expect(github("rate-test", "user")).rejects.toMatchObject({
    retrySeconds: 120,
  });
  await expect(github("rate-test", "user")).rejects.toThrow("rate limit");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("paginates accessible repository choices without following arbitrary Link headers", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const page = new URL(input).searchParams.get("page");
      return Response.json(
        page === "1"
          ? Array.from({ length: 100 }, (_, id) => ({
              id,
              full_name: `acme/repo-${id}`,
            }))
          : [{ id: 101, full_name: "acme/last" }],
        { headers: { Link: '<https://evil.test>; rel="next"' } },
      );
    }),
  );
  expect(await githubOptions("synthetic")).toHaveLength(101);
});

it("records an overlong encoded file link as skipped without blocking the scan", async () => {
  const fetch = mock([entry("src/" + "界".repeat(240) + ".ts")]);
  const page = await githubPage("synthetic", config, null);
  expect(page.items[0]).toMatchObject({
    skip: true,
    note: "File path exceeds the original-link limit.",
  });
  expect(fetch.mock.calls.some(([url]) => url.includes("/blobs/"))).toBe(false);
});
