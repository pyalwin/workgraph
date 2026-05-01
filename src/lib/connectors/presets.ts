// One-click presets for known MCP servers. Picking a preset auto-populates the
// transport, server URL or stdio command, and shows what credentials the user
// must paste. The user only needs to provide the token(s) and click Install.

export type Transport = 'http' | 'stdio';

export interface PresetField {
  name: string;             // logical name (token, jiraUrl, username, etc.)
  label: string;
  placeholder?: string;
  required?: boolean;
  type?: 'text' | 'password' | 'url';
  helpText?: string;
}

export type ConnectorCategory = 'tracker' | 'code' | 'communication' | 'document' | 'meeting';

export interface ConnectorOAuthMeta {
  provider: string;             // matches OAUTH_PROVIDERS key
  preferredOver: 'pat' | null;  // 'pat' = recommend OAuth path over PAT in UI
}

export interface ConnectorPreset {
  source: string;
  label: string;
  blurb: string;            // shown on the install card
  transport: Transport;
  oauth?: ConnectorOAuthMeta;

  // Directory metadata
  category: ConnectorCategory;
  popularity?: number;        // lower = more prominent (1 = most popular)
  badge?: 'new' | 'trending'; // small chip next to name
  // Simple Icons component name (from `react-icons/si`). Optional — falls back
  // to the monogram when no brand glyph exists (e.g. private internal tools).
  iconKey?: string;
  monogram: string;           // 1-2 character fallback glyph
  brandHex: string;           // brand color used for icon fill

  // For HTTP MCP servers
  http?: { url: string };

  // For stdio MCP servers (most one-click cases — installs via npx on first run)
  stdio?: { command: string; args: string[] };

  // What the user has to paste/provide. Mapped into the saved config.
  fields: PresetField[];

  // Optional small steps, rendered as a numbered list.
  setupSteps?: string[];

  // Headline value props ("What you'll get" bullets) shown in the detail sheet.
  features?: string[];

  // Where the user gets their credentials.
  authLink?: { label: string; url: string };

  // Tag indicating viability:
  //  - 'one-click' — paste tokens, click Install, done
  //  - 'guided'    — multi-step setup (creds JSON, OAuth, etc.) — present but warn
  //  - 'planned'   — adapter exists but no preset yet
  status: 'one-click' | 'guided' | 'planned';
}

export const CONNECTOR_PRESETS: Record<string, ConnectorPreset> = {
  jira: {
    source: 'jira',
    label: 'Jira',
    blurb: 'Sync issues, status, comments, and assignees from Jira Cloud.',
    transport: 'stdio',
    oauth: { provider: 'jira', preferredOver: 'pat' },
    category: 'tracker',
    popularity: 1,
    iconKey: 'SiJira',
    monogram: 'J',
    brandHex: '#0052CC',
    stdio: { command: 'npx', args: ['-y', 'mcp-atlassian'] },
    fields: [
      {
        name: 'jiraUrl',
        label: 'Jira site URL',
        placeholder: 'https://your-org.atlassian.net',
        required: true,
        type: 'url',
      },
      {
        name: 'username',
        label: 'Atlassian email',
        placeholder: 'you@company.com',
        required: true,
      },
      {
        name: 'token',
        label: 'Atlassian API token',
        placeholder: 'ATATT...',
        required: true,
        type: 'password',
      },
    ],
    authLink: {
      label: 'Create an Atlassian API token',
      url: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    },
    features: [
      'Issues with full status history',
      'Comments and activity',
      'Assignees, reporters, and watchers',
      'Sprints, epics, components, and labels',
    ],
    status: 'one-click',
  },

  linear: {
    source: 'linear',
    label: 'Linear',
    blurb: 'Sync issues, projects, cycles, and comments from your Linear workspace.',
    transport: 'stdio',
    oauth: { provider: 'linear', preferredOver: 'pat' },
    category: 'tracker',
    popularity: 4,
    iconKey: 'SiLinear',
    monogram: 'L',
    brandHex: '#5E6AD2',
    stdio: { command: 'npx', args: ['-y', '@tacticlaunch/mcp-linear'] },
    fields: [
      {
        name: 'token',
        label: 'Linear personal API key',
        placeholder: 'lin_api_...',
        required: true,
        type: 'password',
      },
    ],
    authLink: {
      label: 'Create a Linear API key',
      url: 'https://linear.app/settings/api',
    },
    features: [
      'Issues across all teams you access',
      'Projects, cycles, and milestones',
      'Labels, priority, and estimates',
      'Comments and activity history',
    ],
    status: 'one-click',
  },

  notion: {
    source: 'notion',
    label: 'Notion',
    blurb: 'Sync pages and databases from a Notion workspace via Internal Integration.',
    transport: 'stdio',
    oauth: { provider: 'notion', preferredOver: 'pat' },
    category: 'document',
    popularity: 3,
    iconKey: 'SiNotion',
    monogram: 'N',
    brandHex: '#000000',
    stdio: { command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'] },
    fields: [
      {
        name: 'token',
        label: 'Notion Internal Integration token',
        placeholder: 'secret_...',
        required: true,
        type: 'password',
        helpText: 'Share at least one page/database with the integration so it can read content.',
      },
    ],
    authLink: {
      label: 'Create a Notion integration',
      url: 'https://www.notion.so/profile/integrations',
    },
    features: [
      'Pages and databases the integration can access',
      'Page content and structured properties',
      'Author and last-edited metadata',
      'Cross-references between pages',
    ],
    status: 'one-click',
  },

  meeting: {
    source: 'meeting',
    label: 'Granola',
    blurb: 'Pull meeting notes, transcripts, and summaries from Granola.',
    transport: 'http',
    category: 'meeting',
    popularity: 8,
    badge: 'new',
    monogram: 'G',
    brandHex: '#4F46E5',
    // Granola has no Simple Icons entry — keeps the monogram fallback.
    http: { url: 'https://api.granola.ai/mcp' },
    fields: [
      {
        name: 'token',
        label: 'Granola API token',
        placeholder: 'gr_...',
        required: true,
        type: 'password',
      },
    ],
    authLink: {
      label: 'Find your Granola API token',
      url: 'https://granola.ai/settings/api',
    },
    setupSteps: [
      'If your team runs Granola self-hosted, replace the URL with your instance.',
    ],
    features: [
      'Meeting transcripts',
      'Auto-generated summaries and action items',
      'Participants and timing',
      'Folder organization',
    ],
    status: 'guided',
  },

  gdrive: {
    source: 'gdrive',
    label: 'Google Drive',
    blurb: 'Sync Docs, Sheets, and Slides metadata + content via Google OAuth.',
    transport: 'stdio',
    category: 'document',
    popularity: 2,
    iconKey: 'SiGoogledrive',
    monogram: 'GD',
    brandHex: '#1FA463',
    stdio: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-gdrive'] },
    fields: [
      {
        name: 'credentialsPath',
        label: 'Path to OAuth credentials JSON',
        placeholder: '/Users/you/.config/gdrive-creds.json',
        required: true,
      },
    ],
    setupSteps: [
      'Create an OAuth Client ID (Desktop) in Google Cloud Console.',
      'Download the credentials.json file and save it locally.',
      'On first sync, a browser window opens to grant Drive access.',
    ],
    authLink: {
      label: 'Open Google Cloud credentials',
      url: 'https://console.cloud.google.com/apis/credentials',
    },
    features: [
      'Docs, Sheets, and Slides metadata',
      'Document content for indexing',
      'Owner and modification history',
      'Folder hierarchy',
    ],
    status: 'guided',
  },

  github: {
    source: 'github',
    label: 'GitHub',
    blurb: 'Sync issues, pull requests, and comments from GitHub repositories.',
    transport: 'stdio',
    oauth: { provider: 'github', preferredOver: 'pat' },
    category: 'code',
    popularity: 5,
    iconKey: 'SiGithub',
    monogram: 'GH',
    brandHex: '#181717',
    stdio: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
    fields: [
      {
        name: 'token',
        label: 'GitHub personal access token',
        placeholder: 'ghp_...',
        required: true,
        type: 'password',
        helpText: 'Needs repo + read:org scope. Fine-grained tokens work for individual repos.',
      },
      {
        name: 'username',
        label: 'Your GitHub username',
        placeholder: 'octocat',
        required: true,
        helpText: 'Sync is scoped to issues/PRs you authored, are assigned to, were mentioned in, or asked to review.',
      },
      {
        name: 'owner',
        label: 'Org or user (optional narrowing)',
        placeholder: 'plateiq',
        helpText: 'Optional — further limits the search to one org or user.',
      },
    ],
    authLink: {
      label: 'Create a GitHub PAT',
      url: 'https://github.com/settings/tokens/new',
    },
    features: [
      'Issues and pull requests across your repos',
      'PR reviews, status, and merge state',
      'Commit history and authors',
      'Labels, milestones, and assignees',
    ],
    status: 'one-click',
  },

  gitlab: {
    source: 'gitlab',
    label: 'GitLab',
    blurb: 'Sync issues, merge requests, and milestones from GitLab.',
    transport: 'stdio',
    category: 'code',
    popularity: 11,
    iconKey: 'SiGitlab',
    monogram: 'GL',
    brandHex: '#FC6D26',
    stdio: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-gitlab'] },
    fields: [
      {
        name: 'token',
        label: 'GitLab personal access token',
        placeholder: 'glpat-...',
        required: true,
        type: 'password',
        helpText: 'Needs api scope.',
      },
      {
        name: 'gitlabUrl',
        label: 'GitLab base URL',
        placeholder: 'https://gitlab.com',
      },
      {
        name: 'projectId',
        label: 'Project or group ID',
        placeholder: 'mygroup/myproject or numeric id',
      },
    ],
    authLink: {
      label: 'Create a GitLab PAT',
      url: 'https://gitlab.com/-/user_settings/personal_access_tokens',
    },
    features: [
      'Issues and merge requests',
      'Milestones and weight estimates',
      'Labels and project metadata',
      'Activity and comment threads',
    ],
    status: 'one-click',
  },

  slack: {
    source: 'slack',
    label: 'Slack',
    blurb: 'Sync channel messages and threads from a Slack workspace.',
    transport: 'stdio',
    category: 'communication',
    popularity: 6,
    iconKey: 'SiSlack',
    monogram: 'S',
    brandHex: '#4A154B',
    oauth: { provider: 'slack', preferredOver: 'pat' },
    stdio: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'] },
    fields: [
      {
        name: 'token',
        label: 'Slack bot token',
        placeholder: 'xoxb-...',
        required: true,
        type: 'password',
        helpText: 'Bot token with channels:history, groups:history, channels:read scopes.',
      },
      {
        name: 'teamId',
        label: 'Workspace (team) ID',
        placeholder: 'T01ABCDEFGH',
        required: true,
      },
      {
        name: 'channelId',
        label: 'Default channel ID',
        placeholder: 'C01ABCDEFGH',
        helpText: 'Optional — adapter will read this channel if no override is passed.',
      },
    ],
    authLink: {
      label: 'Create a Slack app',
      url: 'https://api.slack.com/apps?new_app=1',
    },
    features: [
      'Channel messages and threads',
      'Reactions and edit history',
      'File and link shares',
      'Reply counts and engagement',
    ],
    status: 'one-click',
  },

  teams: {
    source: 'teams',
    label: 'Microsoft Teams',
    blurb: 'Sync channel messages from Microsoft Teams via Graph API.',
    transport: 'stdio',
    category: 'communication',
    popularity: 12,
    // Microsoft Teams logo not available in open icon sets — keeps monogram fallback.
    monogram: 'T',
    brandHex: '#5059C9',
    stdio: { command: 'npx', args: ['-y', '@inditextech/mcp-teams-server'] },
    fields: [
      {
        name: 'tenantId',
        label: 'Azure tenant ID',
        placeholder: '00000000-0000-0000-0000-000000000000',
        required: true,
      },
      {
        name: 'clientId',
        label: 'App (client) ID',
        placeholder: '00000000-0000-0000-0000-000000000000',
        required: true,
      },
      {
        name: 'token',
        label: 'Client secret',
        placeholder: 'value-from-app-registration',
        required: true,
        type: 'password',
      },
      {
        name: 'teamId',
        label: 'Team ID',
        placeholder: '19:abc...@thread.tacv2',
      },
    ],
    setupSteps: [
      'Register an app in Azure AD with ChannelMessage.Read.All (application).',
      'Grant admin consent and create a client secret.',
      'Capture the tenant ID, client ID, and secret.',
    ],
    authLink: {
      label: 'Open Azure App registrations',
      url: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    },
    features: [
      'Channel messages and threads',
      'Reactions and reply counts',
      'Attachments and file shares',
      'Sender identity and timing',
    ],
    status: 'guided',
  },

  confluence: {
    source: 'confluence',
    label: 'Confluence',
    blurb: 'Sync pages and spaces from Confluence Cloud via the Atlassian MCP server.',
    transport: 'stdio',
    category: 'document',
    popularity: 7,
    iconKey: 'SiConfluence',
    monogram: 'C',
    brandHex: '#172B4D',
    stdio: { command: 'npx', args: ['-y', 'mcp-atlassian'] },
    fields: [
      {
        name: 'confluenceUrl',
        label: 'Confluence site URL',
        placeholder: 'https://your-org.atlassian.net/wiki',
        required: true,
        type: 'url',
      },
      {
        name: 'username',
        label: 'Atlassian email',
        placeholder: 'you@company.com',
        required: true,
      },
      {
        name: 'token',
        label: 'Atlassian API token',
        placeholder: 'ATATT...',
        required: true,
        type: 'password',
        helpText: 'Same token format as Jira — can reuse if already created.',
      },
      {
        name: 'space',
        label: 'Default space key',
        placeholder: 'ENG',
        helpText: 'Optional — limits ingest to a single space.',
      },
    ],
    authLink: {
      label: 'Create an Atlassian API token',
      url: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    },
    features: [
      'Pages and spaces you can read',
      'Page content and version history',
      'Labels and metadata',
      'Author and last-edited info',
    ],
    status: 'one-click',
  },

  gcal: {
    source: 'gcal',
    label: 'Google Calendar',
    blurb: 'Sync events from your Google Calendar(s).',
    transport: 'stdio',
    category: 'meeting',
    popularity: 9,
    badge: 'new',
    iconKey: 'SiGooglecalendar',
    monogram: 'GC',
    brandHex: '#4285F4',
    stdio: { command: 'npx', args: ['-y', '@cocal/google-calendar-mcp'] },
    fields: [
      {
        name: 'credentialsPath',
        label: 'OAuth credentials JSON path',
        placeholder: '/Users/you/.config/gcal-creds.json',
        required: true,
      },
      {
        name: 'calendarId',
        label: 'Calendar ID',
        placeholder: 'primary',
      },
    ],
    setupSteps: [
      'Create an OAuth Client ID (Desktop) in Google Cloud Console.',
      'Enable the Google Calendar API for the project.',
      'Save the downloaded credentials.json locally.',
    ],
    authLink: {
      label: 'Open Google Cloud credentials',
      url: 'https://console.cloud.google.com/apis/credentials',
    },
    features: [
      'Events with attendees and conferencing links',
      'Recurring event metadata',
      'Locations and descriptions',
      'Updated/cancelled status',
    ],
    status: 'guided',
  },
};

export function getPreset(source: string): ConnectorPreset | null {
  return CONNECTOR_PRESETS[source.toLowerCase()] ?? null;
}

// Translate the preset's named fields into the generic ConnectorConfigPayload
// shape the API and adapters expect.
export function presetFieldsToPayload(
  preset: ConnectorPreset,
  values: Record<string, string>,
): {
  transport: Transport;
  url?: string;
  token?: string;
  command?: string;
  args?: string[];
  options?: Record<string, unknown>;
  headers?: Record<string, string>;
} {
  const opts: Record<string, unknown> = {};
  let token: string | undefined;
  let url: string | undefined = preset.http?.url;
  let command: string | undefined = preset.stdio?.command;
  let args: string[] | undefined = preset.stdio?.args ? [...preset.stdio.args] : undefined;
  const envEntries: string[] = [];

  for (const field of preset.fields) {
    const v = (values[field.name] ?? '').trim();
    if (!v) continue;
    if (field.name === 'token') token = v;
    else opts[field.name] = v;
  }

  // Adapter-specific glue: each preset maps its named fields to the env vars
  // the underlying MCP server expects. The mcp-client transport pulls leading
  // --env=KEY=VAL args out and merges them into the spawned process env.
  if (preset.source === 'jira' && command) {
    if (opts.jiraUrl) envEntries.push(`JIRA_URL=${opts.jiraUrl}`);
    if (opts.username) envEntries.push(`JIRA_USERNAME=${opts.username}`);
    if (token) envEntries.push(`JIRA_API_TOKEN=${token}`);
  }
  if (preset.source === 'linear' && command && token) {
    envEntries.push(`LINEAR_API_KEY=${token}`);
  }
  if (preset.source === 'notion' && command && token) {
    const hdr = JSON.stringify({ Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' });
    envEntries.push(`OPENAPI_MCP_HEADERS=${hdr}`);
  }
  if (preset.source === 'gdrive' && command && opts.credentialsPath) {
    envEntries.push(`GDRIVE_CREDENTIALS_PATH=${opts.credentialsPath}`);
  }
  if (preset.source === 'github' && command) {
    if (token) envEntries.push(`GITHUB_PERSONAL_ACCESS_TOKEN=${token}`);
    if (opts.owner) envEntries.push(`MCP_GITHUB_OWNER=${opts.owner}`);
  }
  if (preset.source === 'gitlab' && command) {
    if (token) envEntries.push(`GITLAB_PERSONAL_ACCESS_TOKEN=${token}`);
    if (opts.gitlabUrl) envEntries.push(`GITLAB_API_URL=${opts.gitlabUrl}/api/v4`);
    if (opts.projectId) envEntries.push(`MCP_GITLAB_PROJECT_ID=${opts.projectId}`);
  }
  if (preset.source === 'slack' && command) {
    if (token) envEntries.push(`SLACK_BOT_TOKEN=${token}`);
    if (opts.teamId) envEntries.push(`SLACK_TEAM_ID=${opts.teamId}`);
    if (opts.channelId) envEntries.push(`MCP_SLACK_CHANNEL_ID=${opts.channelId}`);
  }
  if (preset.source === 'teams' && command) {
    if (opts.tenantId) envEntries.push(`AZURE_TENANT_ID=${opts.tenantId}`);
    if (opts.clientId) envEntries.push(`AZURE_CLIENT_ID=${opts.clientId}`);
    if (token) envEntries.push(`AZURE_CLIENT_SECRET=${token}`);
    if (opts.teamId) envEntries.push(`MCP_TEAMS_TEAM_ID=${opts.teamId}`);
  }
  if (preset.source === 'confluence' && command) {
    const confluenceUrl = typeof opts.confluenceUrl === 'string' ? opts.confluenceUrl : '';
    if (confluenceUrl) {
      envEntries.push(`CONFLUENCE_URL=${confluenceUrl}`);
      envEntries.push(`JIRA_URL=${confluenceUrl.replace(/\/wiki\/?$/, '')}`);
    }
    if (opts.username) {
      envEntries.push(`CONFLUENCE_USERNAME=${opts.username}`);
      envEntries.push(`JIRA_USERNAME=${opts.username}`);
    }
    if (token) {
      envEntries.push(`CONFLUENCE_API_TOKEN=${token}`);
      envEntries.push(`JIRA_API_TOKEN=${token}`);
    }
    if (opts.space) envEntries.push(`MCP_CONFLUENCE_SPACE=${opts.space}`);
  }
  if (preset.source === 'gcal' && command) {
    if (opts.credentialsPath) envEntries.push(`GOOGLE_OAUTH_CREDENTIALS=${opts.credentialsPath}`);
    if (opts.calendarId) envEntries.push(`MCP_GCAL_CALENDAR_ID=${opts.calendarId}`);
  }

  // We encode env-style hints into args so they survive a generic save; the
  // mcp-client merges any KEY=VALUE leading args back into the spawned env.
  if (envEntries.length && args) {
    args = [...envEntries.map((e) => `--env=${e}`), ...args];
  }

  return {
    transport: preset.transport,
    url,
    token,
    command,
    args,
    options: Object.keys(opts).length ? opts : undefined,
  };
}
