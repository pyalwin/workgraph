import type { MCPConnector } from './types';
import { atlassianConnector } from './adapters/atlassian';
import { linearConnector } from './adapters/linear';
import { notionConnector } from './adapters/notion';
import { granolaConnector } from './adapters/granola';
import { gdriveConnector } from './adapters/gdrive';
import { githubConnector } from './adapters/github';
import { gitlabConnector } from './adapters/gitlab';
import { slackConnector } from './adapters/slack';
import { teamsConnector } from './adapters/teams';
import { confluenceConnector } from './adapters/confluence';
import { gcalConnector } from './adapters/gcal';

export const connectors: Record<string, MCPConnector> = {
  jira: atlassianConnector,
  atlassian: atlassianConnector, // alias
  linear: linearConnector,
  notion: notionConnector,
  granola: granolaConnector,
  meeting: granolaConnector, // alias to match workspace-config 'meeting' source
  gdrive: gdriveConnector,
  github: githubConnector,
  gitlab: gitlabConnector,
  slack: slackConnector,
  teams: teamsConnector,
  confluence: confluenceConnector,
  gcal: gcalConnector,
};

export function getConnector(key: string): MCPConnector {
  const connector = connectors[key.toLowerCase()];
  if (!connector) {
    const available = Object.keys(connectors).join(', ');
    throw new Error(`Unknown connector "${key}". Available: ${available}`);
  }
  return connector;
}

export function listConnectors(): MCPConnector[] {
  // Dedup by reference (since aliases share the same object)
  const seen = new Set<MCPConnector>();
  for (const c of Object.values(connectors)) seen.add(c);
  return Array.from(seen);
}
