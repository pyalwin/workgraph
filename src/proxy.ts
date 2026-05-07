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
    //   - the agent transport (bearer-token auth, no WorkOS session)
    //   - the inngest webhook (HMAC-signed)
    //   - the agent ingest endpoints under /api/almanac/docs/:id/{outline,sections/:section_id}
    // Running authkit on the agent's high-frequency POSTs burned WorkOS rate
    // limits and produced "Failed to exchange WORKOS_CLAIM_TOKEN (429)".
    // The sections exclusion is anchored to a single trailing segment so that
    // browser-auth subroutes (e.g. .../sections/:section_id/regen) still run
    // through authkit. /api/jobs/:id/events stays under the proxy because it
    // uses withAuth() for browser session.
    '/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|manifest.webmanifest|robots.txt|sitemap.xml|api/agent|api/inngest|api/almanac/docs/[^/]+/outline$|api/almanac/docs/[^/]+/sections/[^/]+$).*)',
  ],
};
