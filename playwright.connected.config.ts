import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";
export default defineConfig({
  testDir: "./tests/connected",
  workers: 1,
  use: {
    ...base.use,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    baseURL: "http://127.0.0.1:3200",
  },
  webServer: {
    command:
      "pnpm --filter @loom/web exec next start --hostname 127.0.0.1 --port 3200",
    url: "http://127.0.0.1:3200",
    reuseExistingServer: false,
    env: {
      APP_ORIGIN: "http://127.0.0.1:3200",
      LOOM_AUTH_MODE: "local-demo",
      LOOM_ALLOW_DEMO_PRODUCTION: "true",
    },
  },
});
