import { analytics } from "@/server/desk";
import { endpoint, requireActor } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = endpoint(async () => analytics(await requireActor()));
