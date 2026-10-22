import { exportRequests } from "@/server/imports";
import { endpoint, requireActor } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = endpoint(
  async (request) =>
    new Response(
      await exportRequests(
        await requireActor(),
        Object.fromEntries(new URL(request.url).searchParams),
      ),
      {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="loom-requests.csv"',
          "Cache-Control": "private, no-store",
          Vary: "Cookie",
          "X-Content-Type-Options": "nosniff",
        },
      },
    ),
);
