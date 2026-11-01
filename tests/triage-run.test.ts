import { expect, it } from "vitest";
import type { TriageRun } from "@loom/contracts";
import { conversationPromptVersion } from "../apps/web/server/conversation-model";
import { supportedRun } from "../apps/web/server/triage";

const run = {
  engine: "conversation-v1",
  promptVersion: conversationPromptVersion,
  model: "connected-model",
  toolRevision: "request-desk-v1",
} as TriageRun;
it("allows current assistant proposals for review but not triage advancement", () => {
  expect(() => supportedRun(run, true)).not.toThrow();
  expect(() => supportedRun(run)).toThrow("historical run");
});
it("keeps unknown versions and missing model provenance read-only", () => {
  expect(() =>
    supportedRun({ ...run, promptVersion: "unknown" }, true),
  ).toThrow("historical run");
  expect(() => supportedRun({ ...run, model: null }, true)).toThrow(
    "historical run",
  );
});
