import { NextRequest, NextResponse } from 'next/server';
import {
  deleteChatThread,
  getChatMessages,
  getChatThread,
  renameChatThread,
} from '@/lib/chat-threads';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const thread = await getChatThread(id);
  if (!thread) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const messages = await getChatMessages(id);
  return NextResponse.json({ thread, messages });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { title?: string };
  if (!body.title) return NextResponse.json({ error: 'title required' }, { status: 400 });
  await renameChatThread(id, body.title);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await deleteChatThread(id);
  return NextResponse.json({ ok: true });
}
