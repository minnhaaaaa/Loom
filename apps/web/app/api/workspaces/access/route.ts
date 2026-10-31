import { workspaceAccess } from "@/server/workspaces";
import { endpoint, requireActor } from "@/server/http";
export const runtime = "nodejs";
export const GET = endpoint(async () => workspaceAccess(await requireActor()));
