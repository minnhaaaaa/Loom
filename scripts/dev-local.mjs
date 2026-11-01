// Load .env without passing Node flags that Next's dev worker inherits.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
if (existsSync(".env")) process.loadEnvFile(".env");
process.argv = [
  process.execPath,
  fileURLToPath(
    new URL("../apps/web/node_modules/next/dist/bin/next", import.meta.url),
  ),
  "dev",
  "apps/web",
  "--hostname",
  "127.0.0.1",
  "--port",
  process.env.PORT || "3000",
];
await import("../apps/web/node_modules/next/dist/bin/next");
