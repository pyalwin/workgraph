import { NextRequest, NextResponse } from 'next/server';
import { deleteProviderConfig, upsertProviderConfig } from '@/lib/ai/config-store';
import { isCryptoConfigured } from '@/lib/crypto';

export const dynamic = 'force-dynamic';

// Migrating from 'openrouter' → 'gateway'; keep openrouter accepted for one
// release so an old client doesn't crash before the user re-saves.
const SUPPORTED_PROVIDERS = new Set(['gateway', 'openrouter']);

function unsupported(id: string) {
  return NextResponse.json(
    { error: `Unsupported provider: ${id}` },
    { status: 400 },
  );
}

function cryptoMissing() {
  return NextResponse.json(
    { error: 'WORKGRAPH_SECRET_KEY is not configured. Generate one with `bun scripts/gen-secret.ts` and set it in .env.local.' },
    { status: 500 },
  );
}

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const id = params.id;
  if (!SUPPORTED_PROVIDERS.has(id)) return unsupported(id);
  if (!isCryptoConfigured()) return cryptoMissing();

  const body = (await req.json().catch(() => ({}))) as {
    apiKey?: string | null;
    baseUrl?: string | null;
  };

  const apiKey =
    body.apiKey === null || body.apiKey === ''
      ? null
      : typeof body.apiKey === 'string'
        ? body.apiKey.trim()
        : undefined;

  const baseUrl =
    body.baseUrl === null || body.baseUrl === ''
      ? null
      : typeof body.baseUrl === 'string'
        ? body.baseUrl.trim()
        : undefined;

  await upsertProviderConfig(id, { apiKey, baseUrl });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const id = params.id;
  if (!SUPPORTED_PROVIDERS.has(id)) return unsupported(id);
  if (!isCryptoConfigured()) return cryptoMissing();
  await deleteProviderConfig(id);
  return NextResponse.json({ ok: true });
}
