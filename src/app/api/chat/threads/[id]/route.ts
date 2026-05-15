import { NextRequest, NextResponse } from 'next/server';
import {
  deleteChatThread,
  getChatMessages,
  getChatThread,
  renameChatThread,
} from '@/lib/chat-threads';
import { getActiveWorkspaceId } from '@/lib/active-workspace';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workspaceId = await getActiveWorkspaceId();
  const thread = await getChatThread(workspaceId, id);
  if (!thread) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const messages = await getChatMessages(workspaceId, id);
  return NextResponse.json({ thread, messages });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { title?: string };
  if (!body.title) return NextResponse.json({ error: 'title required' }, { status: 400 });
  const workspaceId = await getActiveWorkspaceId();
  await renameChatThread(workspaceId, id, body.title);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workspaceId = await getActiveWorkspaceId();
  await deleteChatThread(workspaceId, id);
  return NextResponse.json({ ok: true });
}
