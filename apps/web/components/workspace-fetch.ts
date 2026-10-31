"use client";

// This is a stale-tab guard, not an authorization boundary. The server still
// validates sessions, active membership, record scope, and roles on every call.
// Read the company shown by this page, never the mutable account-poll result.
const unscopedPaths = new Set([
  "/api/account",
  "/api/account/login",
  "/api/account/register",
  "/api/session",
  "/api/workspaces/select",
  "/api/invitations/preview",
  "/api/invitations/accept",
]);

export function workspaceFetch(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers),
    pathname = path.split("?")[0];
  if (unscopedPaths.has(pathname)) {
    headers.delete("X-Loom-Workspace");
  } else if (
    path.startsWith("/api/") &&
    !headers.has("X-Loom-Workspace") &&
    typeof document !== "undefined"
  ) {
    const workspace = document
      .querySelector("[data-workspace-id]")
      ?.getAttribute("data-workspace-id");
    if (workspace) headers.set("X-Loom-Workspace", workspace);
  }
  return fetch(path, { ...options, headers });
}
