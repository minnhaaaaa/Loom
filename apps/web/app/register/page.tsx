import type { Metadata } from "next";
import { CompanyEntry } from "@/components/company-entry";
export const metadata: Metadata = { title: "Create your company · Loom" };
export const dynamic = "force-dynamic";
export default function Register() {
  return (
    <CompanyEntry
      mode="register"
      registrationEnabled={process.env.LOOM_ALLOW_WORKSPACE_SIGNUP === "true"}
    />
  );
}
