import { WorkspaceApp } from "@/components/workspace-app";
import { actorFromCookie } from "@/server/http";
import { accountContext } from "@/server/accounts";
import { sampleSnapshot, snapshot } from "@/server/desk";
import type { DeskSnapshot } from "@loom/contracts";
import { notFound } from "next/navigation";
import { localDemoEnabled } from "@/server/demo-mode";
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
  if (demo && !localDemoEnabled()) notFound();
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
        "Your workspace is temporarily unavailable. Please try again shortly.";
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
