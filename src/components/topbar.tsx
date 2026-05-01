'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useWorkgraphState } from '@/components/workgraph-state';

const fallbackMenu = [
  { id: 'overview', label: 'Overview', href: '/', module: 'overview' },
];

export function Topbar() {
  const pathname = usePathname();
  const { state, setState, workspaces, activeWorkspace } = useWorkgraphState();
  const roles = activeWorkspace.ui?.roles?.length ? activeWorkspace.ui.roles : ROLES_FALLBACK;
  const role = roles.find((r) => r.id === state.role) ?? roles[0];
  const source = role?.primarySource ?? state.source;
  const modules = activeWorkspace.modules || {};
  const navItems = activeWorkspace.ui?.menu?.length ? activeWorkspace.ui.menu : fallbackMenu;
  const enabledWorkspaces = workspaces.filter((w) => w.enabled !== false);
  const workspaceOptions = enabledWorkspaces.length > 0 ? enabledWorkspaces : [activeWorkspace];
  const searchPlaceholder = activeWorkspace.ui?.terminology?.searchPlaceholder || 'Search entities, artifacts, decisions...';

  return (
    <header className="topbar">
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <Link href="/" className="brand">
          <span className="brand-mark">W</span>
          <span className="brand-name">WorkGraph</span>
        </Link>
        <nav className="nav">
          {navItems.filter((item) => !item.module || modules[item.module] !== false).map((item) => {
            const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
            return (
              <Link key={item.href} href={item.href} className={active ? 'active' : ''}>
                {item.label}
              </Link>
            );
          })}
          <Link
            href="/settings?tab=workspaces"
            className={pathname.startsWith('/settings') && pathname.includes('workspaces') ? 'active' : ''}
          >
            Workspaces
          </Link>
          <Link
            href="/settings"
            className={pathname.startsWith('/settings') ? 'active' : ''}
          >
            Settings
          </Link>
        </nav>
      </div>
      <div className="top-right">
        <select
          className="workspace-select"
          value={activeWorkspace.id}
          onChange={(event) => setState({ workspaceId: event.target.value })}
          title="Workspace"
        >
          {workspaceOptions.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>
        <div className="search">
          <span>{searchPlaceholder}</span>
          <kbd>⌘K</kbd>
        </div>
        <Link href="/settings?tab=profile" className="role-pill" title="Change role / source">
          <span className="role-pill-label">{role?.label ?? 'workspace'}</span>
          <span className="role-pill-sep">·</span>
          <span className="role-pill-src">{source}</span>
          <span className="role-pill-caret">▾</span>
        </Link>
      </div>
    </header>
  );
}

// Fallback only. Workspaces define their own roles in workspace_config.ui.roles.
export const ROLES: Record<string, { id: string; label: string; subtitle: string; sources: string[]; primarySource: string; live: boolean }> = {
  eng_mgr: {
    id: 'eng_mgr',
    label: 'Engineering Manager',
    subtitle: 'unblocks team, owns portfolio',
    sources: ['Jira', 'GitHub', 'Slack', 'Calendar'],
    primarySource: 'Jira',
    live: true,
  },
  eng_ic: {
    id: 'eng_ic',
    label: 'Engineer',
    subtitle: 'IC · ships features',
    sources: ['Jira', 'GitHub', 'Slack'],
    primarySource: 'Jira',
    live: true,
  },
  pm: {
    id: 'pm',
    label: 'Product Manager',
    subtitle: 'orchestrates roadmap',
    sources: ['Jira', 'Notion', 'Linear', 'Gmail'],
    primarySource: 'Jira',
    live: true,
  },
  sales: {
    id: 'sales', label: 'Sales / AE', subtitle: 'runs the pipeline',
    sources: ['Salesforce', 'Gong', 'Gmail'], primarySource: 'Salesforce', live: false,
  },
  cs: {
    id: 'cs', label: 'Customer Success', subtitle: 'retention & expansion',
    sources: ['Salesforce', 'Gong', 'Zendesk'], primarySource: 'Salesforce', live: false,
  },
  support: {
    id: 'support', label: 'Customer Support', subtitle: 'ticket resolution',
    sources: ['Zendesk', 'Slack'], primarySource: 'Zendesk', live: false,
  },
  specialist: {
    id: 'specialist', label: 'Product Specialist', subtitle: 'implementation partner',
    sources: ['Salesforce', 'Jira', 'Zendesk'], primarySource: 'Salesforce', live: false,
  },
};

export const ROLE_ORDER = ['eng_ic', 'eng_mgr', 'pm', 'sales', 'cs', 'support', 'specialist'];

const ROLES_FALLBACK = [
  { id: 'eng_mgr', label: 'Engineering Manager', primarySource: 'Jira' },
];
