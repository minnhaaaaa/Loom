import type { Metadata } from "next";
import { CompanyEntry } from "@/components/company-entry";
export const metadata: Metadata = { title: "Sign in · Loom" };
export const dynamic = "force-dynamic";
export default function Login() {
  return (
    <CompanyEntry
      mode="login"
      registrationEnabled={process.env.LOOM_ALLOW_WORKSPACE_SIGNUP === "true"}
    />
  );
}
