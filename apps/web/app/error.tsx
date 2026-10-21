"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="fatal">
      <h1>The desk could not load</h1>
      <p>Try again. If this continues, check the server configuration.</p>
      <button onClick={reset}>Try again</button>
    </main>
  );
}
