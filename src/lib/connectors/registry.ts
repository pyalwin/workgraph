import type { Connector } from './types';
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
import { gmailConnector } from './adapters/gmail';

export const connectors: Record<string, Connector> = {
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
  gmail: gmailConnector,
};

export function getConnector(key: string): Connector {
  const connector = connectors[key.toLowerCase()];
  if (!connector) {
    const available = Object.keys(connectors).join(', ');
    throw new Error(`Unknown connector "${key}". Available: ${available}`);
  }
  return connector;
}

export function listConnectors(): Connector[] {
  // Dedup by reference (since aliases share the same object)
  const seen = new Set<Connector>();
  for (const c of Object.values(connectors)) seen.add(c);
  return Array.from(seen);
}
