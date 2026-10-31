import { cookies } from "next/headers";
import { DomainError } from "@loom/domain";
import { openAiLocalRequestUrl } from "@/server/openai-oauth";
import { completeOpenAiConnection } from "@/server/openai-oauth-store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const messages: Record<string, string> = {
  OPENAI_OAUTH_DECLINED:
    "ChatGPT sign-in was not completed. You can try again from Loom.",
  OPENAI_OAUTH_SESSION_CHANGED:
    "Your Loom session expired or the active company changed. Return to Loom and start again.",
  OPENAI_IDENTITY_CONFLICT:
    "Another ChatGPT identity is already linked. Disconnect it in Loom before linking a different account.",
  OPENAI_OAUTH_NOT_CONFIGURED:
    "The local ChatGPT connection is not configured. Open Loom at its configured 127.0.0.1 address.",
};
export async function GET(request: Request) {
  const jar = await cookies();
  const browserToken = jar.get("loom_openai_oauth")?.value;
  jar.set("loom_openai_oauth", "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.APP_ORIGIN?.startsWith("https:") ?? false,
    path: "/api/oauth/openai/callback",
    maxAge: 0,
  });
  let success = false,
    message =
      "ChatGPT sign-in could not be verified. Return to Loom and start a new attempt.";
  try {
    const permitted = await completeOpenAiConnection(
      openAiLocalRequestUrl(request),
      browserToken,
    );
    success = true;
    message = permitted
      ? "Your ChatGPT plan is authorized for your own requests in Loom. Eligible requests use your personal ChatGPT plan; Loom will not silently switch to API billing. Choose a model after returning to Loom."
      : "Your ChatGPT identity is verified, but ChatGPT plan usage was not authorized. You can grant it from Loom.";
  } catch (error) {
    if (error instanceof DomainError) message = messages[error.code] || message;
  }
  // An explicit same-origin navigation restores SameSite=Strict Loom cookies.
  // No session is created/replaced, and no token or callback input is reflected.
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ChatGPT connection · Loom</title><body><main><h1>${success ? "ChatGPT identity verified" : "Connection not completed"}</h1><p>${message}</p><p><a href="/app?view=settings#codex-connection">Return to Loom</a></p></main></body></html>`,
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        "X-Content-Type-Options": "nosniff",
        Vary: "Cookie",
      },
    },
  );
}
