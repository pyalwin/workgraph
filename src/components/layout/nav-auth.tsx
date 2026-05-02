'use client';

import * as Popover from '@radix-ui/react-popover';
import Link from 'next/link';
import { useAuth } from '@workos-inc/authkit-nextjs/components';

function getInitials(name: string, email: string | null | undefined): string {
  const trimmed = name.trim();
  if (trimmed) {
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
    return parts[0]!.slice(0, 2).toUpperCase();
  }
  if (email) return email[0]!.toUpperCase();
  return '?';
}

export function NavAuth() {
  const { user, loading, refreshAuth } = useAuth();

  if (loading) {
    return <span className="nav-auth-loading">…</span>;
  }

  if (!user) {
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

  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ');
  const display = fullName || user.email?.split('@')[0] || 'User';
  const initials = getInitials(fullName, user.email);
  const profilePictureUrl = (user as unknown as { profilePictureUrl?: string }).profilePictureUrl;

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="nav-avatar" aria-label="Account menu" title={display}>
          {profilePictureUrl ? (
            <img src={profilePictureUrl} alt="" className="nav-avatar-img" />
          ) : (
            <span className="nav-avatar-initials">{initials}</span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={8} className="nav-avatar-menu">
          <div className="nav-avatar-menu-head">
            <div className="nav-avatar-menu-name">{display}</div>
            {user.email && <div className="nav-avatar-menu-email">{user.email}</div>}
          </div>
          <div className="nav-avatar-menu-divider" />
          <Popover.Close asChild>
            <Link href="/settings" className="nav-avatar-menu-item">
              <span>Settings</span>
              <span className="nav-avatar-menu-shortcut">⌘,</span>
            </Link>
          </Popover.Close>
          <Popover.Close asChild>
            <Link href="/settings?tab=workspaces" className="nav-avatar-menu-item">
              <span>Workspaces</span>
            </Link>
          </Popover.Close>
          <div className="nav-avatar-menu-divider" />
          <a
            href="/auth/signout"
            className="nav-avatar-menu-item nav-avatar-menu-item-danger"
          >
            Sign out
          </a>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
