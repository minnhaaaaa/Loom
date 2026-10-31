import { readInsights } from "@/server/insights";
import { endpoint, requireActor } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = endpoint(async (request) => {
  const params = new URL(request.url).searchParams;
  // Pass unknown keys through validation; unsupported filters must not be silently ignored.
  const input = Object.fromEntries(params);
  return readInsights(await requireActor(), {
    ...input,
    ...(params.has("days") ? { days: Number(params.get("days")) } : {}),
  });
});
