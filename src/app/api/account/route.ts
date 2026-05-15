/**
 * DELETE /api/account
 *
 * Hard-deletes the calling user's account: wipes their workspace-scoped
 * local data, attempts to revoke OAuth tokens at each connected provider,
 * drops their workspace_config row, and asks WorkOS to delete the user
 * identity.
 *
 * After the WorkOS user is gone, the session_id is no longer valid at
 * WorkOS, so we cannot bounce the client through the normal WorkOS
 * /sessions/logout endpoint — it serves a blank page. Instead we clear
 * the auth cookie in the response and tell the client to navigate to "/"
 * directly.
 */

import { withAuth } from '@workos-inc/authkit-nextjs';
import { NextResponse } from 'next/server';
import { deleteUserAccount } from '@/lib/account';

export const dynamic = 'force-dynamic';

const WORKOS_COOKIE_NAME = process.env.WORKOS_COOKIE_NAME || 'wos-session';
const WG_WORKSPACE_COOKIE = 'wg-workspace';

export async function DELETE() {
  const { user } = await withAuth();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  try {
    const result = await deleteUserAccount(user.id);
    const res = NextResponse.json({
      ...result,
      signOutUrl: '/',
    });
    res.cookies.set(WORKOS_COOKIE_NAME, '', { path: '/', maxAge: 0 });
    res.cookies.set(WG_WORKSPACE_COOKIE, '', { path: '/', maxAge: 0 });
    return res;
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message ?? 'unknown error' },
      { status: 500 },
    );
  }
}
