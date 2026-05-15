import type { CustomTableColumn, CustomTableConfig } from '@/lib/workspace-config';

/**
 * Stage enums per founder pipeline table. Kept in sync with the spec; the
 * column type is plain `text` in the workspace config so we can't infer
 * these from there. If a workspace adds a new pipeline preset it should add
 * its options here too.
 *
 * For `people`, stage semantics shift per `relationship`. We expose a flat
 * union of all stages — the UI groups by relationship so the choices the
 * user sees match their context. PEOPLE_STAGES_BY_RELATIONSHIP gives the
 * subset for each relationship type if the UI wants to narrow the dropdown.
 */
export const STAGE_OPTIONS: Record<string, string[]> = {
  deals: ['discovery', 'poc', 'proposal', 'closed-won', 'closed-lost'],
  investors: ['outreach', 'first-meeting', 'diligence', 'term-sheet', 'passed', 'invested'],
  people: [
    // candidate pipeline
    'sourced', 'screen', 'onsite', 'offer', 'hired', 'passed',
    // team
    'active', 'on-leave', 'alumni',
    // advisor/contractor
    'inactive',
  ],
};

export const PEOPLE_RELATIONSHIPS = [
  'team',
  'candidate',
  'advisor',
  'contractor',
  'mentor',
  'alumni',
  'friend',
  'other',
] as const;
export type PersonRelationship = (typeof PEOPLE_RELATIONSHIPS)[number];

export const PEOPLE_STAGES_BY_RELATIONSHIP: Record<PersonRelationship, string[]> = {
  team: ['active', 'on-leave', 'alumni'],
  candidate: ['sourced', 'screen', 'onsite', 'offer', 'hired', 'passed'],
  advisor: ['active', 'inactive'],
  contractor: ['active', 'inactive'],
  mentor: ['active', 'inactive'],
  alumni: ['alumni'],
  friend: ['active', 'inactive'],
  other: ['active', 'inactive'],
};

export function relationshipLabel(rel: string | null | undefined): string {
  switch (rel) {
    case 'team': return 'Team';
    case 'candidate': return 'Candidates';
    case 'advisor': return 'Advisors';
    case 'contractor': return 'Contractors';
    case 'mentor': return 'Mentors';
    case 'alumni': return 'Alumni';
    case 'friend': return 'Friends of the company';
    case 'other': return 'Other';
    default: return 'Unsorted';
  }
}

const NAME_PRIORITY = ['name', 'firm', 'partner', 'title'];

export function getDisplayName(
  table: CustomTableConfig,
  row: Record<string, unknown>,
): string {
  for (const candidate of NAME_PRIORITY) {
    const v = row[candidate];
    if (typeof v === 'string' && v.trim()) return v;
  }
  // Fall back to the first non-id text column with a value.
  for (const column of table.columns) {
    if (column.primaryKey) continue;
    if (column.type !== 'text') continue;
    const v = row[column.name];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

export function formatColumnValue(column: CustomTableColumn, value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (column.type === 'datetime') {
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleDateString();
  }
  if (column.type === 'boolean') {
    return value ? 'yes' : 'no';
  }
  if (column.type === 'real' || column.type === 'integer') {
    if (typeof value === 'number') return value.toLocaleString();
    return String(value);
  }
  return String(value);
}
