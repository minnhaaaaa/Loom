import { redirect } from "next/navigation";
import { LandingPage } from "@/components/landing-page";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; demo?: string }>;
}) {
  const params = await searchParams;
  // Preserve previously shared workspace deep links.
  if (
    params.view &&
    ["assistant", "records", "settings", "insights", "knowledge"].includes(
      params.view,
    )
  ) {
    redirect(`/app?view=${params.view}`);
  }
  return <LandingPage />;
}
