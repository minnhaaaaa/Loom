import type { NextConfig } from 'next';
import { loadEnvConfig } from '@next/env';
import path from 'node:path';
loadEnvConfig(path.resolve(process.cwd(), '../..'));
const config: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ['@exasol/exasol-driver-ts', 'ws'],
  transpilePackages: ['@loom/contracts','@loom/domain','@loom/db-exasol','@loom/analytics'],
  async headers() { return [{ source: '/:path*', headers: [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'same-origin' },
    { key: 'X-Frame-Options', value: 'DENY' },
  ] }]; },
};
export default config;
