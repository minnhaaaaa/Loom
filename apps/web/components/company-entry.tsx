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
          loom<span>↗</span>
        </Link>
        <Link href={mode === "login" ? "/register" : "/login"}>
          {mode === "login"
            ? "Register your company"
            : "Already a member? Sign in"}
        </Link>
      </nav>
      <div className="company-entry-heading">
        <p>THE WORK BEHIND THE ANSWER</p>
        <h1>
          {mode === "register"
            ? "Make room for analysis."
            : "Back to the work that matters."}
        </h1>
      </div>
      <AccountAccess
        initialMode={mode}
        onAuthenticated={async () => {
          window.location.assign(
            mode === "register" ? "/app?view=settings#company-setup" : "/app",
          );
        }}
      />
      <footer>
        <span>One company. Individual accounts. Clear ownership.</span>
        <Link href="/app?demo=1">Explore a sample workspace ↗</Link>
      </footer>
    </main>
  );
}
