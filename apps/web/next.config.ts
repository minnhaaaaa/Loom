import type { NextConfig } from "next";
import { loadEnvConfig } from "@next/env";
import path from "node:path";
loadEnvConfig(path.resolve(process.cwd(), "../.."));
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
