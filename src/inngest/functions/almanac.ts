/**
 * Almanac Inngest functions.
 *
 * almanac.fanOutSections  — listens for 'almanac/outline.received'
 *   Reads the doc + sections, inserts one almanac.draft-section agent_jobs
 *   row per section with status='queued', and sets each section's job_id.
 *
 * almanac.assemble        — listens for 'almanac/section.completed'
 *   Checks if all sections are done; if so, marks the doc status='complete'.
 *
 * almanac.handleJobFailure — listens for 'agent/job.failed'
 *   For almanac.outline failures: sets the parent doc to status='failed'.
 *   For almanac.draft-section failures: sets the relevant section to status='failed'.
 */

import { v4 as uuid } from 'uuid';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { inngest } from '../client';

// ─── fan-out ────────────────────────────────────────────────────────────────

interface DocRow {
  id: string;
  workspace_id: string;
  project_key: string;
  repo_key: string;
  ref: string;
  outline: string | null;
}

interface SectionRow {
  section_id: string;
  ordinal: number;
  status: string;
}

export const almanacFanOutSections = inngest.createFunction(
  {
    id: 'almanac-fan-out-sections',
    name: 'Almanac · fan out draft-section jobs',
    triggers: [{ event: 'almanac/outline.received' }],
    // One fan-out per doc at a time.
    concurrency: { key: 'event.data.doc_id', limit: 1 },
  },
  async ({ event, step }) => {
    const { doc_id: docId } = event.data as { doc_id: string };

    const jobIds = await step.run('queue-section-jobs', async () => {
      await ensureSchemaAsync();
      const db = getLibsqlDb();

      const doc = await db
        .prepare(
          `SELECT id, workspace_id, project_key, repo_key, ref, outline
           FROM almanac_docs WHERE id = ?`,
        )
        .get<DocRow>(docId);

      if (!doc || !doc.outline) {
        throw new Error(`Doc ${docId} not found or missing outline`);
      }

      const outline = JSON.parse(doc.outline) as unknown;

      const sections = await db
        .prepare(
          `SELECT section_id, ordinal, status
           FROM almanac_doc_sections
           WHERE doc_id = ? AND status = 'queued'
           ORDER BY ordinal ASC`,
        )
        .all<SectionRow>(docId);

      const createdJobIds: string[] = [];

      for (const section of sections) {
        const jobId = uuid();
        const params = JSON.stringify({
          workspaceId: doc.workspace_id,
          projectKey: doc.project_key,
          repoKey: doc.repo_key,
          ref: doc.ref,
          doc_id: docId,
          section_id: section.section_id,
          outline,
        });

        await db
          .prepare(
            `INSERT INTO agent_jobs (id, workspace_id, kind, status, params)
             VALUES (?, ?, 'almanac.draft-section', 'queued', ?)`,
          )
          .run(jobId, doc.workspace_id, params);

        await db
          .prepare(
            `UPDATE almanac_doc_sections
             SET status = 'drafting', job_id = ?, updated_at = datetime('now')
             WHERE doc_id = ? AND section_id = ?`,
          )
          .run(jobId, docId, section.section_id);

        createdJobIds.push(jobId);
      }

      return createdJobIds;
    });

    return { doc_id: docId, jobs_created: jobIds.length };
  },
);

// ─── assemble ───────────────────────────────────────────────────────────────

interface SectionStatusRow {
  status: string;
}

export const almanacAssemble = inngest.createFunction(
  {
    id: 'almanac-assemble',
    name: 'Almanac · assemble doc on section completion',
    triggers: [{ event: 'almanac/section.completed' }],
    // One assembly check per doc at a time.
    concurrency: { key: 'event.data.doc_id', limit: 1 },
  },
  async ({ event, step }) => {
    const { doc_id: docId } = event.data as { doc_id: string; section_id: string };

    const result = await step.run('check-and-assemble', async () => {
      await ensureSchemaAsync();
      const db = getLibsqlDb();

      const sections = await db
        .prepare(
          `SELECT status FROM almanac_doc_sections WHERE doc_id = ?`,
        )
        .all<SectionStatusRow>(docId);

      if (sections.length === 0) {
        return { assembled: false, reason: 'no sections' };
      }

      const allDone = sections.every((s) => s.status === 'done');
      if (!allDone) {
        const pending = sections.filter((s) => s.status !== 'done').length;
        return { assembled: false, reason: `${pending} section(s) not yet done` };
      }

      await db
        .prepare(
          `UPDATE almanac_docs
           SET status = 'complete', completed_at = datetime('now')
           WHERE id = ? AND status != 'complete'`,
        )
        .run(docId);

      return { assembled: true };
    });

    return { doc_id: docId, ...result };
  },
);

// ─── failure handler ─────────────────────────────────────────────────────────

interface JobFailedEventData {
  job_id: string;
  kind: string;
  params: Record<string, unknown>;
}

interface JobKindRow {
  kind: string;
  params: string;
}

export const almanacHandleJobFailure = inngest.createFunction(
  {
    id: 'almanac-handle-job-failure',
    name: 'Almanac · handle agent job failure',
    triggers: [{ event: 'agent/job.failed' }],
  },
  async ({ event, step }) => {
    const data = event.data as JobFailedEventData;
    const jobId = data.job_id;

    await step.run('handle-failure', async () => {
      await ensureSchemaAsync();
      const db = getLibsqlDb();

      const job = await db
        .prepare(`SELECT kind, params FROM agent_jobs WHERE id = ?`)
        .get<JobKindRow>(jobId);

      if (!job) return { handled: false, reason: 'job not found' };

      // Only handle almanac job kinds.
      if (!job.kind.startsWith('almanac.')) {
        return { handled: false, reason: 'not an almanac job' };
      }

      let params: Record<string, unknown>;
      try {
        params = JSON.parse(job.params) as Record<string, unknown>;
      } catch {
        return { handled: false, reason: 'could not parse job params' };
      }

      if (job.kind === 'almanac.outline') {
        const docId = params['doc_id'] as string | undefined;
        if (!docId) return { handled: false, reason: 'no doc_id in params' };

        await db
          .prepare(`UPDATE almanac_docs SET status = 'failed' WHERE id = ? AND status = 'outlining'`)
          .run(docId);

        return { handled: true, kind: 'outline', doc_id: docId };
      }

      if (job.kind === 'almanac.draft-section') {
        const docId = params['doc_id'] as string | undefined;
        const sectionId = params['section_id'] as string | undefined;
        if (!docId || !sectionId) return { handled: false, reason: 'no doc_id/section_id in params' };

        await db
          .prepare(
            `UPDATE almanac_doc_sections
             SET status = 'failed', updated_at = datetime('now')
             WHERE doc_id = ? AND section_id = ? AND status = 'drafting'`,
          )
          .run(docId, sectionId);

        return { handled: true, kind: 'draft-section', doc_id: docId, section_id: sectionId };
      }

      return { handled: false, reason: `unhandled kind: ${job.kind}` };
    });

    return { job_id: jobId };
  },
);
