import type { NextConfig } from "next";
import { loadEnvConfig } from "@next/env";
import { fileURLToPath } from "node:url";
// Next may already have cached an empty apps/web environment. Load the shared
// repository configuration explicitly, independent of the invocation directory.
loadEnvConfig(
  fileURLToPath(new URL("../..", import.meta.url)),
  process.env.NODE_ENV !== "production",
  console,
  true,
);
// Use ws's supported JS masking path; optional native stubs can break Next bundles.
process.env.WS_NO_BUFFER_UTIL = "1";
const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  serverExternalPackages: ["@exasol/exasol-driver-ts", "ws"],
  transpilePackages: [
    "@loom/contracts",
    "@loom/domain",
    "@loom/db-exasol",
    "@loom/analytics",
  ],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};
export default config;
