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
    unauthenticatedPaths: ['/', '/sign-in', '/auth/callback', '/auth/signout'],
  },
  debug: false,
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
