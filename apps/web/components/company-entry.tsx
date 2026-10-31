"use client";

import Link from "next/link";
import { AccountAccess } from "./account-access";

export function CompanyEntry({ mode }: { mode: "login" | "register" }) {
  return (
    <main className="company-entry">
      <nav aria-label="Account navigation">
        <Link
          className="company-entry-wordmark"
          href="/"
          aria-label="Loom home"
        >
          LOOM
        </Link>
        <Link href={mode === "login" ? "/register" : "/login"}>
          {mode === "login" ? "Create your company" : "Sign in"}
        </Link>
      </nav>
      <div className="company-entry-heading">
        <h1>{mode === "register" ? "Create your company" : "Sign in"}</h1>
      </div>
      <AccountAccess
        minimalPublic
        initialMode={mode}
        onAuthenticated={async () => {
          window.location.assign(
            mode === "register" ? "/app?view=settings#company-setup" : "/app",
          );
        }}
      />
      <footer>
        <Link href="/app?demo=1">Explore sample ↗</Link>
      </footer>
    </main>
  );
}
