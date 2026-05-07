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
      '/api/agent/:path*',
    ],
  },
  debug: false,
});

export const config = {
  matcher: [
    // Skip the authkit proxy on:
    //   - static assets
    //   - bearer-token agent endpoints (heartbeat, jobs/*, pair/start, pair/poll)
    //   - the inngest webhook (HMAC-signed)
    //   - the agent ingest endpoints under /api/almanac/docs/:id/{outline,sections/:section_id}
    //
    // Running authkit on the agent's high-frequency POSTs burned WorkOS rate
    // limits and produced "Failed to exchange WORKOS_CLAIM_TOKEN (429)".
    //
    // /api/agent/pair/confirm is the one agent path that DOES need authkit
    // (the user's browser confirms the pairing via withAuth), so it's
    // deliberately NOT in the exclusion list. Same applies to
    // .../sections/:id/regen — anchored exclusions let browser-auth
    // subroutes still run through authkit.
    '/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|manifest.webmanifest|robots.txt|sitemap.xml|api/agent/(?:heartbeat|jobs|pair/(?:start|poll))|api/inngest|api/almanac/docs/[^/]+/outline$|api/almanac/docs/[^/]+/sections/[^/]+$).*)',
  ],
};
