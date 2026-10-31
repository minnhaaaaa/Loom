import { z } from "zod";
import { endpoint, jsonBody, switchWorkspace } from "@/server/http";
export const runtime = "nodejs";
export const POST = endpoint(async (request) => {
  const { workspaceId } = z
    .object({ workspaceId: z.uuid() })
    .strict()
    .parse(await jsonBody(request));
  await switchWorkspace(workspaceId);
  return { ok: true };
}, true);
