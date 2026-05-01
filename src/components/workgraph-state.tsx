'use client';

import { createContext, useContext, useEffect, useState, ReactNode, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';

export type Theme = 'warm' | 'mono';
export type Density = 'compact' | 'comfortable' | 'spacious';
export type Variation = 'briefing' | 'agenda' | 'canvas';
export type ProjLayout = 'ledger' | 'atlas';

export interface WgState {
  workspaceId: string;
  role: string;
  source: string;
  theme: Theme;
  dark: boolean;
  density: Density;
  variation: Variation;
  projLayout: ProjLayout;
  projAtRisk: boolean;
  showCapture: boolean;
  showDigest: boolean;
  showPillars: boolean;
}

const DEFAULTS: WgState = {
  workspaceId: 'default',
  role: 'owner',
  source: 'Primary System',
  theme: 'warm',
  dark: false,
  density: 'comfortable',
  variation: 'briefing',
  projLayout: 'ledger',
  projAtRisk: true,
  showCapture: true,
  showDigest: true,
  showPillars: false,
};

export interface WorkspaceSummary {
  id: string;
  name: string;
  preset: string;
  enabled: boolean;
  modules: Record<string, boolean>;
  ui?: {
    menu?: Array<{ id: string; label: string; href: string; module?: string }>;
    roles?: Array<{ id: string; label: string; description?: string; primarySource?: string }>;
    terminology?: Record<string, string>;
  };
}

interface Ctx {
  state: WgState;
  setState: (update: Partial<WgState> | ((s: WgState) => WgState)) => void;
  workspaces: WorkspaceSummary[];
  activeWorkspace: WorkspaceSummary;
  setupComplete: boolean;
  loadingWorkspaces: boolean;
  refreshWorkspaces: () => Promise<void>;
}

const WgCtx = createContext<Ctx | null>(null);

export function WorkgraphStateProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [state, setStateRaw] = useState<WgState>(DEFAULTS);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [setupComplete, setSetupComplete] = useState(false);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  const prevWorkspaceId = useRef<string | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem('wg-tweaks');
      if (raw) setStateRaw({ ...DEFAULTS, ...JSON.parse(raw) });
    } catch {
      // ignore
    }
    setHydrated(true);
  }, []);

  const refreshWorkspaces = useCallback(async () => {
    try {
      setLoadingWorkspaces(true);
      const res = await fetch('/api/workspaces');
      const data = await res.json();
      if (Array.isArray(data.workspaces)) {
        const nextWorkspaces = data.workspaces.map((w: any) => ({
          id: w.id,
          name: w.name,
          preset: w.preset,
          enabled: w.enabled ?? true,
          modules: w.modules || {},
          ui: w.ui || {},
        }));
        setWorkspaces(nextWorkspaces);
        setSetupComplete(Boolean(data.setupComplete ?? nextWorkspaces.some((w: WorkspaceSummary) => w.enabled !== false)));
      }
    } catch {
      // Keep local fallback if workspace API is unavailable.
    } finally {
      setLoadingWorkspaces(false);
    }
  }, []);

  const setState = useCallback(
    (update: Partial<WgState> | ((s: WgState) => WgState)) => {
      setStateRaw((prev) => (typeof update === 'function' ? update(prev) : { ...prev, ...update }));
    },
    [],
  );

  useEffect(() => {
    refreshWorkspaces();
  }, [refreshWorkspaces]);

  useEffect(() => {
    if (!hydrated || workspaces.length === 0) return;
    const current = workspaces.find((w) => w.id === state.workspaceId);
    if (current && current.enabled === false) {
      const firstEnabled = workspaces.find((w) => w.enabled !== false);
      if (firstEnabled && firstEnabled.id !== state.workspaceId) {
        setState({ workspaceId: firstEnabled.id });
      }
    }
  }, [workspaces, state.workspaceId, hydrated, setState]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem('wg-tweaks', JSON.stringify(state));
    } catch {
      // ignore
    }
    document.body.classList.toggle('dark', state.dark);
    document.body.classList.toggle('theme-mono', state.theme === 'mono');
    document.body.dataset.density = state.density;
  }, [state, hydrated]);

  const activeWorkspace =
    workspaces.find((workspace) => workspace.id === state.workspaceId && workspace.enabled !== false) ??
    workspaces.find((workspace) => workspace.enabled !== false) ??
    {
      id: 'default',
      name: 'Default Workspace',
      preset: 'bare',
      enabled: true,
      modules: { overview: true, projects: false, knowledge: true, goals: true, otti: false },
      ui: {
        menu: [
          { id: 'overview', label: 'Overview', href: '/', module: 'overview' },
          { id: 'knowledge', label: 'Knowledge', href: '/knowledge', module: 'knowledge' },
          { id: 'goals', label: 'Metrics', href: '/metrics', module: 'goals' },
        ],
        roles: [{ id: 'owner', label: 'Workspace Owner', primarySource: 'Primary System' }],
        terminology: { searchPlaceholder: 'Search entities, artifacts, decisions...' },
      },
    };

  useEffect(() => {
    if (prevWorkspaceId.current !== null && prevWorkspaceId.current !== state.workspaceId) {
      const menu = activeWorkspace.ui?.menu;
      const landingHref = menu?.[0]?.href ?? '/';
      router.push(landingHref);
    }
    prevWorkspaceId.current = state.workspaceId;
  }, [state.workspaceId, activeWorkspace, router]);

  return (
    <WgCtx.Provider
      value={{
        state,
        setState,
        workspaces,
        activeWorkspace,
        setupComplete,
        loadingWorkspaces,
        refreshWorkspaces,
      }}
    >
      {children}
    </WgCtx.Provider>
  );
}

export function useWorkgraphState() {
  const ctx = useContext(WgCtx);
  if (!ctx) throw new Error('useWorkgraphState must be used within WorkgraphStateProvider');
  return ctx;
}
