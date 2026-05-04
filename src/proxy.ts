import { authkitProxy } from '@workos-inc/authkit-nextjs';

/**
 * Auth gating.
 *
 * Public paths: marketing root, AuthKit handshake routes, sign-in entry.
 * Everything else (the entire `(app)` route group) is protected — the
 * proxy redirects unauthenticated requests to the WorkOS-hosted sign-in
 * page automatically.
 */
export default authkitProxy({
  middlewareAuth: {
    enabled: true,
    unauthenticatedPaths: [
      '/',
      '/sign-in',
      '/auth/callback',
      '/auth/signout',
      '/api/inngest',
      // Almanac local-agent pair flow + job protocol — these endpoints
      // authenticate themselves via Bearer token (verifyAgentRequest) or
      // are device-code pairing endpoints that must be reachable without a
      // browser session.
      '/api/agent/pair/start',
      '/api/agent/pair/poll',
      '/api/agent/heartbeat',
      '/api/agent/jobs/poll',
      '/api/agent/jobs/result',
      // Almanac ingest endpoints — Bearer-token auth via verifyAgentRequest
      '/api/almanac/code-events/ingest',
      '/api/almanac/file-lifecycle/ingest',
      '/api/almanac/noise/classify/ingest',
      '/api/almanac/clusters/ingest',
      '/api/almanac/units/ingest',
      '/api/almanac/sections/ingest',
    ],
  },
  debug: false,
});

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|manifest.webmanifest|robots.txt|sitemap.xml).*)',
  ],
};
