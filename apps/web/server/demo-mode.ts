/** Synthetic fixtures are available only in an explicitly configured local test environment. */
export function localDemoEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.LOOM_AUTH_MODE !== "local-demo" || !env.APP_ORIGIN) return false;
  try {
    const origin = new URL(env.APP_ORIGIN);
    return (
      ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) &&
      ["http:", "https:"].includes(origin.protocol) &&
      (env.NODE_ENV !== "production" ||
        env.LOOM_ALLOW_DEMO_PRODUCTION === "true")
    );
  } catch {
    return false;
  }
}
