'use client';

import { useAuth } from '@workos-inc/authkit-nextjs/components';

export function NavAuth() {
  const { user, loading, refreshAuth } = useAuth();

  if (loading) {
    return <span className="nav-auth-loading">...</span>;
  }

  if (user) {
    return (
      <div className="nav-auth">
        <span className="nav-auth-user" title={user.email ?? undefined}>
          {user.firstName ?? user.email?.split('@')[0] ?? 'User'}
        </span>
        <a href="/auth/signout" className="nav-auth-btn">
          Sign out
        </a>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="nav-auth-btn"
      onClick={() => void refreshAuth({ ensureSignedIn: true })}
    >
      Sign in
    </button>
  );
}
