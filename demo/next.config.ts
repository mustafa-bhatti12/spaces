import path from 'node:path';
import type { NextConfig } from 'next';

// demo/ is its own npm project inside the space repo (no root package.json). Pin the root so Next
// doesn't go looking for lockfiles in parent directories (e.g. a stray one above the repo).
const root = path.resolve(__dirname);

const nextConfig: NextConfig = {
  turbopack: { root },
  outputFileTracingRoot: root,
};

export default nextConfig;
