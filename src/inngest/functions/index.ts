/**
 * Registry of every Inngest function. Add new functions here so they're
 * picked up by the /api/inngest serve handler.
 */
import { heartbeat } from './heartbeat';
import { jiraSyncTick, jiraSyncWorkspace } from './jira-sync';
import { connectorSyncWorkspace } from './connector-sync';
import { anomalyScan } from './anomalies';
import { projectSummaryRegen } from './project-summary';
import { projectActionsRefresh } from './project-actions';
import { projectReadmeRefresh } from './project-readme';
import { projectOkrsRefresh } from './project-okrs';
import { githubTrailsRefreshWorkspace, issuePrSummaryRefresh, unmatchedPrAiMatcher } from './github-trails';
import { chunkEmbedRun } from './chunk-embed';
import { almanacCodeEventsBackfill } from './almanac-code-events-backfill';
import { almanacNoiseClassify } from './almanac-noise-classify';
import { almanacDetectModulesAndUnits } from './almanac-detect-modules-and-units';

export const functions = [
  heartbeat,
  almanacCodeEventsBackfill,
  almanacNoiseClassify,
  almanacDetectModulesAndUnits,
  jiraSyncTick,
  jiraSyncWorkspace,
  connectorSyncWorkspace,
  anomalyScan,
  projectSummaryRegen,
  projectActionsRefresh,
  projectReadmeRefresh,
  projectOkrsRefresh,
  githubTrailsRefreshWorkspace,
  issuePrSummaryRefresh,
  unmatchedPrAiMatcher,
  chunkEmbedRun,
];
