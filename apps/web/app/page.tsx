import { WorkspaceApp } from "@/components/workspace-app";
import { actorFromCookie } from "@/server/http";
import { accountContext } from "@/server/accounts";
import { snapshot } from "@/server/desk";
import type { DeskSnapshot } from "@loom/contracts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const requestedView = (await searchParams).view;
  const initialView =
    requestedView === "records" ||
    requestedView === "settings" ||
    requestedView === "assistant"
      ? requestedView
      : undefined;
  let initial: DeskSnapshot = {
    mode: "connected",
    membership: null,
    requests: [],
    members: [],
  };
  let initialError: string | null = null;
  let account = await accountContext(null);
  try {
    const actor = await actorFromCookie();
    account = await accountContext(actor);
    initial = await snapshot(account.currentWorkspaceId ? actor : null);
  } catch {
    initialError =
      "The desk could not connect. Check Exasol and the local session configuration, then refresh.";
  }
  return (
    <WorkspaceApp
      initial={initial}
      initialError={initialError}
      initialAccount={account}
      initialView={initialView}
    />
  );
}
