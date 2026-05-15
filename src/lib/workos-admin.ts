/**
 * Thin WorkOS REST helpers for operations the @workos-inc/node SDK either
 * doesn't cover or that we'd rather call directly to keep the dependency
 * surface small. Right now: hard-deleting a User Management user as part of
 * the account-deletion cascade.
 *
 * Authn uses the same WORKOS_API_KEY env var that authkit reads — so this
 * helper is no-op-safe in environments that don't have it set (returns false
 * with a warning rather than throwing).
 */

const WORKOS_API_BASE = 'https://api.workos.com';

/**
 * Deletes a user from WorkOS user management.
 * Returns true on success, false on any failure (network, 4xx, 5xx).
 * Logs errors but never throws — the caller decides whether to fail the
 * overall delete on the basis of this returning false.
 *
 * 404 is treated as success: WorkOS already has no record of this user, so
 * the desired end-state is reached and a retry from the caller would be
 * pointless.
 */
export async function deleteWorkosUser(userId: string): Promise<boolean> {
  const apiKey = process.env.WORKOS_API_KEY;
  if (!apiKey) {
    console.warn('[workos-admin] WORKOS_API_KEY not set — skipping WorkOS user deletion');
    return false;
  }
  try {
    const res = await fetch(
      `${WORKOS_API_BASE}/user_management/users/${encodeURIComponent(userId)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      },
    );
    if (res.status === 204 || res.status === 200) return true;
    if (res.status === 404) return true; // already deleted — idempotent
    const txt = await res.text().catch(() => '');
    console.error(
      `[workos-admin] delete user ${userId} failed: ${res.status} ${txt.slice(0, 200)}`,
    );
    return false;
  } catch (err: any) {
    console.error(`[workos-admin] delete user ${userId} threw: ${err?.message ?? err}`);
    return false;
  }
}
