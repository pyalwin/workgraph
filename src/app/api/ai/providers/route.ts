import { NextResponse } from 'next/server';
import { listProviderConfigSummaries } from '@/lib/ai/config-store';
import { isCryptoConfigured } from '@/lib/crypto';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (!isCryptoConfigured()) {
    return NextResponse.json(
      { error: 'WORKGRAPH_SECRET_KEY is not configured. Generate one with `bun scripts/gen-secret.ts` and set it in .env.local.' },
      { status: 500 },
    );
  }
  return NextResponse.json({ providers: await listProviderConfigSummaries() });
}
