// Maps the human-readable connector slots from WORKSPACE_PRESETS to the
// MCP adapter source ids in our registry. A slot may have several
// candidates — the user picks one in the configure dialog.

export interface SlotOption {
  source: string;     // matches connectors registry key
  label: string;      // human-friendly name shown in the picker
  status: 'available' | 'planned';
}

export const SLOT_OPTIONS: Record<string, SlotOption[]> = {
  // Engineering
  'Jira or Linear': [
    { source: 'jira', label: 'Jira (Atlassian)', status: 'available' },
    { source: 'linear', label: 'Linear', status: 'available' },
  ],
  'GitHub or GitLab': [
    { source: 'github', label: 'GitHub', status: 'available' },
    { source: 'gitlab', label: 'GitLab', status: 'available' },
  ],
  'Slack or Teams': [
    { source: 'slack', label: 'Slack', status: 'available' },
    { source: 'teams', label: 'Microsoft Teams', status: 'available' },
  ],
  'Notion, Confluence, or Drive': [
    { source: 'notion', label: 'Notion', status: 'available' },
    { source: 'gdrive', label: 'Google Drive', status: 'available' },
    { source: 'confluence', label: 'Confluence', status: 'available' },
  ],
  'Calendar or meeting tools': [
    { source: 'meeting', label: 'Granola', status: 'available' },
    { source: 'gcal', label: 'Google Calendar', status: 'available' },
  ],

  // Sales / Ops / Legal / Finance shared
  'Gmail or Outlook': [
    { source: 'gmail', label: 'Gmail', status: 'planned' },
  ],
  'Docs or knowledge base': [
    { source: 'notion', label: 'Notion', status: 'available' },
    { source: 'gdrive', label: 'Google Drive', status: 'available' },
  ],
  'Drive, SharePoint, or DMS': [
    { source: 'gdrive', label: 'Google Drive', status: 'available' },
  ],
  'Tracker or ticketing system': [
    { source: 'jira', label: 'Jira', status: 'available' },
    { source: 'linear', label: 'Linear', status: 'available' },
  ],
  'Salesforce or HubSpot': [
    { source: 'salesforce', label: 'Salesforce', status: 'planned' },
    { source: 'hubspot', label: 'HubSpot', status: 'planned' },
  ],
  'Gong or call intelligence': [
    { source: 'gong', label: 'Gong', status: 'planned' },
  ],
  'Matter system': [
    { source: 'matter', label: 'Matter Tracker', status: 'planned' },
  ],
  'ERP or accounting system': [
    { source: 'erp', label: 'ERP / Accounting', status: 'planned' },
  ],
  'Sheets, warehouse, or BI': [
    { source: 'gdrive', label: 'Google Sheets (via Drive)', status: 'available' },
  ],
  'Approval tools': [
    { source: 'approvals', label: 'Approval Workflow', status: 'planned' },
  ],

  // Custom workspace
  'Primary system': [
    { source: 'jira', label: 'Jira', status: 'available' },
    { source: 'linear', label: 'Linear', status: 'available' },
    { source: 'notion', label: 'Notion', status: 'available' },
  ],
  'Slack, Teams, or email': [
    { source: 'slack', label: 'Slack', status: 'planned' },
    { source: 'gmail', label: 'Gmail', status: 'planned' },
  ],
  'Configured custom tables': [],
};

export function optionsForSlot(slot: string): SlotOption[] {
  return SLOT_OPTIONS[slot] ?? [];
}
