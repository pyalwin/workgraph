import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { dismiss, isDismissed, listDismissals, undismiss } from '@/lib/user-dismissals';

export const dynamic = 'force-dynamic';

const KEY_RE = /^[a-z0-9_-]{1,64}$/;

export async function GET(req: NextRequest) {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const key = req.nextUrl.searchParams.get('key');
  if (key) {
    if (!KEY_RE.test(key)) return NextResponse.json({ error: 'Invalid key' }, { status: 400 });
    return NextResponse.json({ dismissed: await isDismissed(user.id, key) });
  }

  return NextResponse.json({ dismissals: await listDismissals(user.id) });
}

export async function POST(req: NextRequest) {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { key?: string };
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!KEY_RE.test(key)) return NextResponse.json({ error: 'Invalid key' }, { status: 400 });

  await dismiss(user.id, key);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const key = req.nextUrl.searchParams.get('key');
  if (!key || !KEY_RE.test(key)) return NextResponse.json({ error: 'Invalid key' }, { status: 400 });

  await undismiss(user.id, key);
  return NextResponse.json({ ok: true });
}
