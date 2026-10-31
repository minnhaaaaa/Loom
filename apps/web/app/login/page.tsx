import type { Metadata } from "next";
import { CompanyEntry } from "@/components/company-entry";
export const metadata: Metadata = { title: "Sign in · Loom" };
export default function Login() {
  return <CompanyEntry mode="login" />;
}
