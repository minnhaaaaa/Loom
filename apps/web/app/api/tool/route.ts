import { endpoint, requireActor } from "@/server/http";
import { toolWorkspace } from "@/server/tools";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = endpoint(async () => toolWorkspace(await requireActor()));
