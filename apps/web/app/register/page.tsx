import type { Metadata } from "next";
import { CompanyEntry } from "@/components/company-entry";
export const metadata: Metadata = { title: "Create your company · Loom" };
export default function Register() {
  return <CompanyEntry mode="register" />;
}
