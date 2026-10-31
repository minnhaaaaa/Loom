import { beforeEach, expect, it, vi } from "vitest";
import type { Actor } from "@loom/contracts";
const boundary = vi.hoisted(() => ({ credential: vi.fn() }));
vi.mock("../apps/web/server/openai-oauth-store", () => ({
  getOpenAiPlanCredential: boundary.credential,
}));
import {
  personalPlanModel,
  personalPlanRuntime,
} from "../apps/web/server/personal-plan";
const actor: Actor = { workspaceId: "company-a", userId: "owner-a" };
const plan = {
  clientId: "issued-local-client",
  subject: "owner-chatgpt-subject",
  revision: 3,
  model: "available-model",
  planEnabled: true,
};
beforeEach(() => {
  boundary.credential.mockReset();
});
it("resolves only the current actor's approved plan without persisting credentials in the model identity", async () => {
  boundary.credential.mockResolvedValue({
    ...plan,
    accessToken: "private-token-fixture",
    expiresAt: Date.now() + 60_000,
  });
  const runtime = await personalPlanRuntime(actor, plan);
  expect(boundary.credential).toHaveBeenCalledExactlyOnceWith(actor);
  expect(runtime).toMatchObject({
    provider: "openai-chatgpt",
    key: "private-token-fixture",
    model: plan.model,
    revision: 3,
  });
  expect(personalPlanModel(plan)).toBe("openai-chatgpt:available-model@3");
  expect(personalPlanModel({ ...plan, model: null })).toBeNull();
});
it.each([
  null,
  { ...plan, planEnabled: false },
  { ...plan, model: null },
  { ...plan, model: "different-model" },
  { ...plan, clientId: "another-client" },
  { ...plan, subject: "another-owner" },
  { ...plan, revision: 4 },
])(
  "fails closed when the grant changes instead of choosing another billing source (%j)",
  async (credential) => {
    boundary.credential.mockResolvedValue(credential);
    await expect(personalPlanRuntime(actor, plan)).rejects.toMatchObject({
      code: "OPENAI_CONNECTION_CHANGED",
    });
  },
);
it("propagates a renewal failure without a retry or provider fallback", async () => {
  boundary.credential.mockRejectedValue(new Error("renewal unavailable"));
  await expect(personalPlanRuntime(actor, plan)).rejects.toThrow(
    "renewal unavailable",
  );
  expect(boundary.credential).toHaveBeenCalledTimes(1);
});
