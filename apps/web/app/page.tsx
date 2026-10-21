import { Desk } from "@/components/desk";
import { actorFromCookie } from "@/server/http";
import { snapshot } from "@/server/desk";
import type { DeskSnapshot } from "@loom/contracts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function Home() {
  let initial: DeskSnapshot = {
    mode: "connected",
    membership: null,
    requests: [],
    members: [],
  };
  let initialError: string | null = null;
  try {
    initial = await snapshot(await actorFromCookie());
  } catch {
    initialError =
      "The desk could not connect. Check Exasol and the local session configuration, then refresh.";
  }
  return <Desk initial={initial} initialError={initialError} />;
}
