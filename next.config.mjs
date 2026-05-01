/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['better-sqlite3', '@modelcontextprotocol/sdk', 'sqlite-vec'],
  },
};

export default nextConfig;
