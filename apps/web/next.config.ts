import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // `next dev` would otherwise write AGENTS.md / CLAUDE.md into this package: instruction files that coding agents load. The repository's own
  // instructions live in the root CLAUDE.md, and running the documented dev workflow must not create files in the checkout.
  agentRules: false,
};

export default nextConfig;
