import { withAxiomNextConfig } from 'next-axiom';

/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['better-sqlite3', '@modelcontextprotocol/sdk', 'sqlite-vec'],
};

export default withAxiomNextConfig(nextConfig);
