import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { personas, workspaceId } from "@loom/contracts";

const boundary = vi.hoisted(() => ({
  signedIn: true,
  cookies: vi.fn(),
  sessionActor: vi.fn(),
  draft: vi.fn(),
}));
vi.mock("../apps/web/node_modules/next/headers.js", () => ({
  cookies: boundary.cookies,
}));
vi.mock("../apps/web/server/accounts", () => ({
  accountContext: vi.fn(),
  sessionActor: boundary.sessionActor,
  revokeSession: vi.fn(),
  selectSessionWorkspace: vi.fn(),
}));
vi.mock("../apps/web/server/knowledge", () => ({
  createKnowledgeFromProposal: boundary.draft,
}));
import { POST } from "../apps/web/app/api/proposals/[id]/knowledge/route";

const origin = "http://127.0.0.1:3000";
const proposalId = randomUUID();
const actor = { workspaceId, userId: personas[1].id };
const values = {
  commandId: randomUUID(),
  hash: "a".repeat(64),
  title: "Confirm the reporting window",
  body: "Confirm the reporting window before assigning the request.",
  rationale: "The operator reviewed this behavior in the source case.",
};
beforeEach(() => {
  vi.stubEnv("LOOM_AUTH_MODE", "workspace");
  vi.stubEnv("APP_ORIGIN", origin);
  vi.stubEnv(
    "LOOM_SESSION_SECRET",
    "public-test-secret-at-least-thirty-two-characters",
  );
  boundary.signedIn = true;
  boundary.cookies.mockReset().mockImplementation(async () => ({
    get: (name: string) =>
      boundary.signedIn && name === "loom_session"
        ? { name, value: "test-only-account-token" }
        : undefined,
  }));
  boundary.sessionActor.mockReset().mockResolvedValue(actor);
  boundary.draft
    .mockReset()
    .mockResolvedValue({ id: randomUUID(), state: "draft" });
});
afterEach(() => vi.unstubAllEnvs());

function request(headers: Record<string, string> = {}, body: object = values) {
  return new Request(`${origin}/api/proposals/${proposalId}/knowledge`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
function context(id: string = proposalId) {
  return { params: Promise.resolve({ id }) };
}

it("rejects cross-origin, missing-origin and non-JSON requests before accessing the session or service", async () => {
  for (const mutation of [
    request({ origin: "https://attacker.example" }),
    request({ origin: "" }),
    request({ "content-type": "text/plain" }),
  ]) {
    const response = await POST(mutation, context());
    expect([403, 415]).toContain(response.status);
  }
  expect(boundary.cookies).not.toHaveBeenCalled();
  expect(boundary.draft).not.toHaveBeenCalled();
});

it("requires an authenticated server-derived actor and rejects client-forged source metadata", async () => {
  boundary.signedIn = false;
  const unauthenticated = await POST(request(), context());
  expect(unauthenticated.status).toBe(401);
  expect(boundary.draft).not.toHaveBeenCalled();
  boundary.signedIn = true;
  for (const body of [
    { ...values, workspaceId: randomUUID() },
    { ...values, provenance: { reviewedBy: actor.userId } },
  ]) {
    const invalid = await POST(request({}, body), context());
    expect(invalid.status).toBe(422);
  }
  const invalidId = await POST(request(), context("untrusted-source-id"));
  expect(invalidId.status).toBe(422);
  expect(boundary.draft).not.toHaveBeenCalled();
});

it("passes the validated proposal and cookie actor to the transactional service with private response caching", async () => {
  const response = await POST(request(), context());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("Cookie");
  expect(boundary.draft).toHaveBeenCalledExactlyOnceWith(actor, proposalId, {
    ...values,
    kind: "procedure",
  });
  expect(await response.json()).toMatchObject({ state: "draft" });
});
