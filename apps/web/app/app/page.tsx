import { WorkspaceApp } from "@/components/workspace-app";
import { actorFromCookie } from "@/server/http";
import { accountContext } from "@/server/accounts";
import { sampleSnapshot, snapshot } from "@/server/desk";
import type { DeskSnapshot } from "@loom/contracts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; demo?: string }>;
}) {
  const params = await searchParams;
  const requestedView = params.view;
  const demo = params.demo === "1";
  const initialView =
    requestedView === "records" ||
    requestedView === "settings" ||
    requestedView === "assistant" ||
    requestedView === "insights" ||
    requestedView === "knowledge"
      ? requestedView
      : demo
        ? "records"
        : undefined;
  let initial: DeskSnapshot = {
    mode: "connected",
    membership: null,
    requests: [],
    members: [],
  };
  let initialError: string | null = null;
  let account = await accountContext(null);
  if (demo) {
    initial = sampleSnapshot();
  } else
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
