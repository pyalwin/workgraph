import { NextRequest, NextResponse } from 'next/server';
import { deleteProviderConfig, upsertProviderConfig } from '@/lib/ai/config-store';
import { isCryptoConfigured } from '@/lib/crypto';

export const dynamic = 'force-dynamic';

const SUPPORTED_PROVIDERS = new Set(['anthropic']);

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

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
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

  upsertProviderConfig(id, { apiKey, baseUrl });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const id = params.id;
  if (!SUPPORTED_PROVIDERS.has(id)) return unsupported(id);
  if (!isCryptoConfigured()) return cryptoMissing();
  deleteProviderConfig(id);
  return NextResponse.json({ ok: true });
}
