import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { getSetting, setSetting } from '@/lib/app-settings';

export const dynamic = 'force-dynamic';

const KEY = 'ai.active_provider';
const VALID = new Set(['auto', 'gateway', 'openrouter']);

export async function GET() {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // 'auto' = use the implicit resolution in src/lib/ai/index.ts
  const stored = (await getSetting(KEY)) ?? 'auto';
  return NextResponse.json({ provider: stored });
}

export async function PUT(req: NextRequest) {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { provider?: string };
  const provider = (body.provider ?? '').trim().toLowerCase();
  if (!VALID.has(provider)) {
    return NextResponse.json({ error: `Invalid provider. Use one of: ${[...VALID].join(', ')}` }, { status: 400 });
  }

  await setSetting(KEY, provider === 'auto' ? null : provider);
  return NextResponse.json({ ok: true, provider });
}
