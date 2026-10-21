import { defineConfig } from "vitest/config";
import base from "./vitest.config.ts";
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["tests/database/**/*.integration.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
