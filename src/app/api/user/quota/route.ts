import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { getQuota } from '@/lib/ai/quota';
import { getMonthlyUsage } from '@/lib/ai/usage-store';

export const dynamic = 'force-dynamic';

const DEFAULT_WORKSPACE_ID = process.env.WORKGRAPH_WORKSPACE_ID?.trim() || 'default';

/**
 * Returns the workspace's current monthly AI usage and remaining free-tier
 * budget. Cost is the primary metric; call count is exposed as a secondary
 * anti-abuse signal. Used by the budget bar in Settings → AI and the
 * quota-exceeded upsell modal that surfaces when a sync/chat call hits the cap.
 */
export async function GET(req: NextRequest) {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const workspaceId = req.nextUrl.searchParams.get('workspaceId') ?? DEFAULT_WORKSPACE_ID;
  const [quota, usage] = await Promise.all([getQuota(workspaceId), getMonthlyUsage(workspaceId)]);

  return NextResponse.json({
    workspaceId,
    period: usage.period,
    activeProvider: quota.activeProvider,
    enforced: quota.enforced,
    cost: {
      limitUsdMicros: quota.costLimitUsdMicros,
      usedUsdMicros: quota.costUsedUsdMicros,
      remainingUsdMicros: quota.costRemainingUsdMicros,
    },
    calls: {
      limit: quota.callLimit,
      used: quota.callUsed,
      remaining: quota.callRemaining,
    },
    totals: {
      tokensIn: usage.totalTokensIn,
      tokensOut: usage.totalTokensOut,
    },
    byTask: usage.byTask,
  });
}
