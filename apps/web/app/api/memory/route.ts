import { memoryQuerySchema } from "@loom/contracts";
import { endpoint, requireActor } from "@/server/http";
import { readTeamMemory } from "@/server/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = endpoint(async (request) => {
  const actor = await requireActor();
  const query = memoryQuerySchema.parse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  return readTeamMemory(actor, query);
});
