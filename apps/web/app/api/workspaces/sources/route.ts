import { z } from "zod";
import { sourceProviderSchema, sourceSelectionSchema } from "@loom/contracts";
import { DomainError } from "@loom/domain";
import { endpoint, jsonBody, requireActor } from "@/server/http";
import {
  browseSources,
  changeSource,
  selectSource,
  sourceSnapshot,
  reviewSourceItem,
  setRequestMode,
} from "@/server/sources";
import {
  connectSlack,
  disconnectSourceConnection,
  pollMicrosoftSignin,
  startMicrosoftSignin,
} from "@/server/source-connections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const inputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("request-mode"),
      id: z.uuid(),
      mode: z.enum(["detect", "all"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("review"),
      id: z.uuid(),
      externalId: z.string().min(1).max(300),
      hash: z.string().regex(/^[a-f0-9]{64}$/),
      decision: z.enum(["accept", "dismiss"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("connect-slack"),
      token: z.string().min(10).max(2000),
    })
    .strict(),
  z.object({ action: z.literal("connect-microsoft") }).strict(),
  z.object({ action: z.literal("poll-microsoft"), id: z.uuid() }).strict(),
  z
    .object({
      action: z.literal("disconnect"),
      provider: z.enum(["slack", "microsoft"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("browse"),
      provider: sourceProviderSchema,
      parentId: z.string().max(300).default(""),
      query: z.string().max(100).default(""),
    })
    .strict(),
  z
    .object({ action: z.literal("select"), selection: sourceSelectionSchema })
    .strict(),
  z
    .object({ action: z.enum(["pause", "resume", "sync"]), id: z.uuid() })
    .strict(),
]);
async function scopedActor(request: Request) {
  const actor = await requireActor();
  if (request.headers.get("x-loom-workspace") !== actor.workspaceId)
    throw new DomainError(
      "WORKSPACE_CHANGED",
      "Your active company changed. Reload connected sources.",
      409,
    );
  return actor;
}
export const GET = endpoint(async (request) =>
  sourceSnapshot(await scopedActor(request)),
);
export const POST = endpoint(async (request) => {
  const actor = await scopedActor(request),
    input = inputSchema.parse(await jsonBody(request, 8000));
  switch (input.action) {
    case "connect-slack":
      await connectSlack(actor, input.token);
      return sourceSnapshot(actor);
    case "connect-microsoft":
      return startMicrosoftSignin(actor);
    case "poll-microsoft":
      return pollMicrosoftSignin(actor, input.id);
    case "disconnect":
      await disconnectSourceConnection(actor, input.provider);
      return sourceSnapshot(actor);
    case "browse":
      return browseSources(actor, input.provider, input.parentId, input.query);
    case "request-mode":
      await setRequestMode(actor, input.id, input.mode);
      return sourceSnapshot(actor);
    case "review":
      await reviewSourceItem(
        actor,
        input.id,
        input.externalId,
        input.hash,
        input.decision,
      );
      return sourceSnapshot(actor);
    case "select":
      await selectSource(actor, input.selection);
      return sourceSnapshot(actor);
    default:
      await changeSource(actor, input.id, input.action);
      return sourceSnapshot(actor);
  }
}, true);
