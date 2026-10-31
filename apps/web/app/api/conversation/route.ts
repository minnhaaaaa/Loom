import { conversationSendSchema } from "@loom/contracts";
import { readConversation, sendConversation } from "@/server/conversation";
import { endpoint, jsonBody, requireActor } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = endpoint(async () => readConversation(await requireActor()));
export const POST = endpoint(
  async (request) =>
    sendConversation(
      await requireActor(),
      conversationSendSchema.parse(await jsonBody(request)),
      request.signal,
    ),
  true,
);
