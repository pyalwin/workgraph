import { NextRequest, NextResponse } from 'next/server';
import { createChatThread, listChatThreads } from '@/lib/chat-threads';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ threads: await listChatThreads() });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { title?: string };
  const thread = await createChatThread(body.title);
  return NextResponse.json({ thread });
}
