import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  workers: 2,
  use: {
    baseURL: "http://127.0.0.1:3100",
    headless: true,
    launchOptions: {
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
  },
  webServer: {
    command:
      "pnpm --filter @loom/web exec next start --hostname 127.0.0.1 --port 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    env: {
      APP_ORIGIN: "http://127.0.0.1:3100",
      LOOM_AUTH_MODE: "local-demo",
      LOOM_ALLOW_DEMO_PRODUCTION: "true",
      LOOM_SESSION_SECRET: "public-test-only-session-key-do-not-deploy",
      EXASOL_HOST: "",
      EXASOL_USER: "",
      EXASOL_PASSWORD: "",
    },
  },
});
