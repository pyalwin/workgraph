/**
 * Registry of every Inngest function. Add new functions here so they're
 * picked up by the /api/inngest serve handler.
 */
import { heartbeat } from './heartbeat';
import { jiraSyncTick, jiraSyncWorkspace } from './jira-sync';
import { anomalyScan } from './anomalies';
import { projectSummaryRegen } from './project-summary';
import { projectActionsRefresh } from './project-actions';

export const functions = [
  heartbeat,
  jiraSyncTick,
  jiraSyncWorkspace,
  anomalyScan,
  projectSummaryRegen,
  projectActionsRefresh,
];
