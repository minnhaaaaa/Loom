import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/web", import.meta.url)),
      "@exasol/exasol-driver-ts": fileURLToPath(
        new URL(
          "./packages/db-exasol/node_modules/@exasol/exasol-driver-ts/dist/index.esm.js",
          import.meta.url,
        ),
      ),
      "@loom/contracts/fixtures": fileURLToPath(
        new URL("./packages/contracts/src/fixtures.ts", import.meta.url),
      ),
      "server-only": fileURLToPath(
        new URL("./tests/server-only.ts", import.meta.url),
      ),
      ...Object.fromEntries(
        ["contracts", "domain", "db-exasol", "analytics"].map((name) => [
          `@loom/${name}`,
          fileURLToPath(
            new URL(`./packages/${name}/src/index.ts`, import.meta.url),
          ),
        ]),
      ),
    },
  },
  test: { include: ["tests/**/*.test.ts"] },
});
