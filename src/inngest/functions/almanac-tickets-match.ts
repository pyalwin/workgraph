/**
 * Almanac · ticket-first matcher (Phase 3 — KAN-45)
 *
 * Cron: 0 6 * * 1 (Monday 06:00 UTC — 30 min after detect-modules-and-units).
 * Manual: send event `workgraph/almanac.tickets.match`.
 *
 * Steps:
 *   1. resolve-workspace   — from event.data.workspaceId or 'default'
 *   2. find-orphans        — call findOrphanTickets(), up to 200
 *   3. match-tickets-N..M  — chunk into groups of 10, run matchTicket() per
 *                            group so each step stays well under 30s.
 *
 * Returns { ok, orphans, candidates_total, auto_attached }.
 *
 * Concurrency: one run per workspace at a time.
 */
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { findOrphanTickets, matchTicket, type OrphanTicket } from '@/lib/sync/ticket-code-matcher';
import { inngest } from '../client';

const CHUNK_SIZE = 10; // tickets per step.run() to keep step durations sane

export const almanacTicketsMatch = inngest.createFunction(
  {
    id: 'almanac-tickets-match',
    name: 'Almanac · ticket-first matcher',
    triggers: [
      { cron: '0 6 * * 1' },                           // weekly — Monday 06:00 UTC
      { event: 'workgraph/almanac.tickets.match' },    // manual trigger
    ],
    concurrency: [{ key: 'event.data.workspaceId', limit: 1 }],
  },
  async ({ event, step }) => {
    // Step 1 — resolve workspace from event payload or fall back to 'default'
    const workspaceId = await step.run('resolve-workspace', async () => {
      return (event.data as { workspaceId?: string })?.workspaceId ?? 'default';
    });

    // Step 2 — find all orphan tickets for this workspace
    const orphans = await step.run('find-orphans', async () => {
      await ensureSchemaAsync();
      return findOrphanTickets(workspaceId);
    });

    if (orphans.length === 0) {
      return { ok: true, orphans: 0, candidates_total: 0, auto_attached: 0 };
    }

    // Step 3..N — process in chunks of CHUNK_SIZE so each step is short-lived.
    let candidatesTotal = 0;
    let autoAttached = 0;
    const chunkCount = Math.ceil(orphans.length / CHUNK_SIZE);

    for (let i = 0; i < chunkCount; i++) {
      const chunk: OrphanTicket[] = orphans.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);

      const chunkResult = await step.run(`match-tickets-${i}`, async () => {
        let chunkCandidates = 0;
        let chunkAutoAttached = 0;
        for (const ticket of chunk) {
          try {
            const result = await matchTicket(workspaceId, ticket);
            chunkCandidates += result.candidates.length;
            chunkAutoAttached += result.auto_attached;
          } catch (err: unknown) {
            // Log per-ticket errors but continue so one bad ticket can't abort
            // the entire run. Surfaced as a console.error for Inngest's log
            // viewer — not returned in the step result to avoid serialising
            // arbitrarily large error strings into Inngest state.
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[almanac-tickets-match] matchTicket(${ticket.source_id}) failed: ${msg}`);
          }
        }
        return { candidates: chunkCandidates, auto_attached: chunkAutoAttached };
      });

      candidatesTotal += chunkResult.candidates;
      autoAttached += chunkResult.auto_attached;
    }

    return {
      ok: true,
      orphans: orphans.length,
      candidates_total: candidatesTotal,
      auto_attached: autoAttached,
    };
  },
);
