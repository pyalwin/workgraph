import { NextRequest, NextResponse } from 'next/server';
import { createChatThread, listChatThreads } from '@/lib/chat-threads';
import { getActiveWorkspaceId } from '@/lib/active-workspace';

export const dynamic = 'force-dynamic';

export async function GET() {
  const workspaceId = await getActiveWorkspaceId();
  return NextResponse.json({ threads: await listChatThreads(workspaceId) });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { title?: string };
  const workspaceId = await getActiveWorkspaceId();
  const thread = await createChatThread(workspaceId, body.title);
  return NextResponse.json({ thread });
}
