import { z } from "zod";
import { notFound } from "next/navigation";
import { WorkspaceLink } from "@/components/workspace-link";
export default async function SharedWorkspace({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const parsed = z.uuid().safeParse((await params).id);
  if (!parsed.success) notFound();
  return <WorkspaceLink workspaceId={parsed.data} />;
}
