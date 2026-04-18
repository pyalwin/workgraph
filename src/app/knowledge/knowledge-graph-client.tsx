'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { Badge } from '@/components/ui/badge';
import { Markdown } from '@/components/prompt-kit/markdown';

const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false });

/* ---- Types ---- */

interface GraphNode {
  id: string;
  title: string;
  summary: string | null;
  source: string;
  source_id: string;
  item_type: string;
  status: string | null;
  author: string | null;
  url: string | null;
  body: string | null;
  created_at: string;
  type_tag: string | null;
  topic_tags: string | null;
  goal_names: string | null;
  trace_role: string | null;
  substance: string | null;
  trace_event_at: string | null;
  workstream_ids: string | null;
  // force-graph props
  val: number;
  color: string;
  x?: number;
  y?: number;
}

interface SearchHit {
  id: string;
  title: string;
  source: string;
  item_type: string;
  trace_role: string | null;
  match_excerpt: string;
  distance: number;
  workstream_ids: string[];
}

interface WorkstreamTimelineEvent {
  item_id: string;
  source: string;
  role: string | null;
  time: string;
  title: string;
  one_liner: string;
}

interface WorkstreamDetail {
  id: string;
  narrative: string | null;
  timeline_events: WorkstreamTimelineEvent[];
  earliest_at: string;
  latest_at: string;
  is_seed: number;
  is_terminal: number;
  role_in_workstream: string | null;
}

interface DecisionTraceEntry {
  item_id: string;
  source: string;
  role: string;
  time: string;
  title: string;
  contribution: string;
}

interface DecisionStructured {
  context: string;
  decision: string;
  rationale: string;
  what_was_asked: string;
  what_was_shipped: string;
  gap_analysis: string;
  status_note: string;
  discussion_trace: DecisionTraceEntry[];
  implementation_trace: DecisionTraceEntry[];
}

interface DecisionRecord {
  id: string;
  item_id: string;
  title: string;
  decided_at: string;
  decided_by: string | null;
  status: string;
  summary: DecisionStructured | null;
  generated_at: string | null;
  relation?: string;
  item_count?: number;
}

interface GraphEdge {
  id: string;
  source_item_id: string;
  target_item_id: string;
  link_type: string;
  confidence: number;
}

interface GraphLink {
  source: string | GraphNode;
  target: string | GraphNode;
  type: string;
  color: string;
}

interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

/* ---- Constants ---- */

const sourceColors: Record<string, string> = {
  jira: '#111',
  github: '#333',
  slack: '#555',
  meeting: '#777',
  granola: '#777',
  notion: '#999',
  gmail: '#bbb',
};

const sourceLabels: Record<string, string> = {
  jira: 'Jira',
  github: 'GitHub',
  slack: 'Slack',
  meeting: 'Meetings',
  granola: 'Meetings',
  notion: 'Notion',
  gmail: 'Gmail',
};

const linkTypeColors: Record<string, string> = {
  implements: '#7c3aed',
  references: '#1a8754',
  discusses: '#3b82f6',
  mentions: '#ccc',
};

const linkTypeLabels: Record<string, string> = {
  implements: 'Implements',
  references: 'References',
  discusses: 'Discusses',
  mentions: 'Mentions',
};

const traceRoleColors: Record<string, string> = {
  seed:           '#e11d48', // red — start
  discussion:     '#f59e0b', // amber
  decision:       '#d97706', // orange
  specification:  '#2563eb', // blue
  implementation: '#7c3aed', // violet
  review:         '#0891b2', // cyan
  integration:    '#16a34a', // green — terminal
  follow_up:      '#6b7280', // grey
};

const traceRoleLabels: Record<string, string> = {
  seed: 'Seed',
  discussion: 'Discussion',
  decision: 'Decision',
  specification: 'Spec',
  implementation: 'Implementation',
  review: 'Review',
  integration: 'Integration',
  follow_up: 'Follow-up',
};

const statusOptions = ['All', 'Open', 'Active', 'Done'] as const;

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trim() + '...';
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/* ---- Component ---- */

export default function KnowledgeGraphClient() {
  const graphRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
  const [rawEdges, setRawEdges] = useState<GraphEdge[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [sourceFilters, setSourceFilters] = useState<Record<string, boolean>>({
    jira: true,
    github: true,
    slack: true,
    meeting: true,
    granola: true,
    notion: true,
    gmail: true,
  });
  const [statusFilter, setStatusFilter] = useState<string>('All');
  const [typeFilters, setTypeFilters] = useState<Set<string>>(new Set());

  // Selection
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const searchHighlight = useMemo(() => new Set(searchResults.map(r => r.id)), [searchResults]);

  // Coloring mode
  const [colorMode, setColorMode] = useState<'source' | 'trace_role'>('source');

  // Workstream detail for selected node
  const [workstreams, setWorkstreams] = useState<WorkstreamDetail[]>([]);
  const [activeWorkstreamId, setActiveWorkstreamId] = useState<string | null>(null);

  // Decisions
  const [allDecisions, setAllDecisions] = useState<DecisionRecord[]>([]);
  const [nodeDecisions, setNodeDecisions] = useState<DecisionRecord[]>([]);
  const [activeDecisionId, setActiveDecisionId] = useState<string | null>(null);

  // Graph dimensions
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  // Fetch graph data
  useEffect(() => {
    async function fetchGraph() {
      try {
        const res = await fetch('/api/graph');
        if (!res.ok) return;
        const data = await res.json();

        // Build link count map
        const linkCountMap: Record<string, number> = {};
        for (const edge of data.edges) {
          linkCountMap[edge.source_item_id] = (linkCountMap[edge.source_item_id] || 0) + 1;
          linkCountMap[edge.target_item_id] = (linkCountMap[edge.target_item_id] || 0) + 1;
        }

        const nodes: GraphNode[] = data.nodes.map((item: any) => {
          const isEpic = item.source === 'jira' && (item.item_type === 'epic' || item.item_type === 'Epic');
          const baseVal = Math.max(2, (linkCountMap[item.id] || 0) * 2);
          return {
            ...item,
            val: isEpic ? baseVal * 2.5 + 6 : baseVal,
            color: item.trace_role ? (traceRoleColors[item.trace_role] ?? sourceColors[item.source] ?? '#999') : (sourceColors[item.source] ?? '#999'),
          };
        });

        const nodeIds = new Set(nodes.map((n) => n.id));
        const links: GraphLink[] = data.edges
          .filter((edge: GraphEdge) => nodeIds.has(edge.source_item_id) && nodeIds.has(edge.target_item_id))
          .map((edge: GraphEdge) => ({
            source: edge.source_item_id,
            target: edge.target_item_id,
            type: edge.link_type,
            color: linkTypeColors[edge.link_type] || '#ddd',
          }));

        setGraphData({ nodes, links });
        setRawEdges(data.edges);
      } catch {
        // silently handle
      } finally {
        setLoading(false);
      }
    }
    fetchGraph();
  }, []);

  // Resize observer for graph container
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function updateSize() {
      const rect = container!.getBoundingClientRect();
      const w = Math.max(rect.width, 400);
      const h = Math.max(rect.height, 400);
      setDimensions({ width: w, height: h });
    }

    // Initial size
    updateSize();

    const observer = new ResizeObserver(() => updateSize());
    observer.observe(container);
    window.addEventListener('resize', updateSize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateSize);
    };
  }, [loading]);

  // Configure forces and zoom to fit after data loads
  useEffect(() => {
    if (!loading && graphData.nodes.length > 0 && graphRef.current) {
      const fg = graphRef.current;

      // Spread nodes out much more
      fg.d3Force('charge')?.strength(-200).distanceMax(500);
      fg.d3Force('link')?.distance(100).strength(0.3);
      fg.d3ReheatSimulation();

      // Multiple zoomToFit attempts to ensure it centers
      const t1 = setTimeout(() => fg.zoomToFit(400, 80), 1000);
      const t2 = setTimeout(() => fg.zoomToFit(400, 80), 3000);
      const t3 = setTimeout(() => fg.zoomToFit(400, 80), 6000);
      return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
    }
  }, [loading, graphData.nodes.length]);

  // Derive available type tags
  const availableTypes = useMemo(() => {
    const types = new Set<string>();
    for (const node of graphData.nodes) {
      if (node.type_tag) {
        for (const t of node.type_tag.split(',')) {
          types.add(t.trim());
        }
      }
    }
    return Array.from(types).sort();
  }, [graphData.nodes]);

  // Filter the graph data
  const filteredData = useMemo(() => {
    const filteredNodes = graphData.nodes.filter((node) => {
      // Source filter
      if (!sourceFilters[node.source]) return false;

      // Status filter
      if (statusFilter !== 'All') {
        const nodeStatus = (node.status || 'open').toLowerCase().replace('_', '');
        const filterStatus = statusFilter.toLowerCase();
        if (filterStatus === 'active' && nodeStatus !== 'active' && nodeStatus !== 'inprogress' && nodeStatus !== 'in_progress') return false;
        if (filterStatus === 'done' && nodeStatus !== 'done') return false;
        if (filterStatus === 'open' && nodeStatus !== 'open') return false;
      }

      // Type filter
      if (typeFilters.size > 0) {
        if (!node.type_tag) return false;
        const nodeTags = node.type_tag.split(',').map((t) => t.trim());
        if (!nodeTags.some((t) => typeFilters.has(t))) return false;
      }

      return true;
    });

    const filteredNodeIds = new Set(filteredNodes.map((n) => n.id));
    const filteredLinks = graphData.links.filter((link) => {
      const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
      const targetId = typeof link.target === 'string' ? link.target : link.target.id;
      return filteredNodeIds.has(sourceId) && filteredNodeIds.has(targetId);
    });

    return { nodes: filteredNodes, links: filteredLinks };
  }, [graphData, sourceFilters, statusFilter, typeFilters]);

  // Re-center when filters change
  useEffect(() => {
    if (graphRef.current && filteredData.nodes.length > 0) {
      const timer = setTimeout(() => {
        graphRef.current?.zoomToFit(400, 80);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [sourceFilters, statusFilter, typeFilters]);

  // Debounced semantic search
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&k=40`);
        const json = await res.json();
        setSearchResults(json.results || []);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [searchQuery]);

  // Fetch the recent-decisions list once
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/decisions');
        if (!res.ok) return;
        const json = await res.json();
        setAllDecisions(json.decisions ?? []);
      } catch {}
    })();
  }, []);

  // Fetch workstreams + decisions for the selected node
  useEffect(() => {
    if (!selectedNode) {
      setWorkstreams([]);
      setActiveWorkstreamId(null);
      setNodeDecisions([]);
      setActiveDecisionId(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/items/${selectedNode.id}`);
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;
        setWorkstreams(json.workstreams ?? []);
        const firstWithNarrative = (json.workstreams ?? []).find((w: WorkstreamDetail) => w.narrative) ?? (json.workstreams ?? [])[0];
        setActiveWorkstreamId(firstWithNarrative?.id ?? null);

        const ds: DecisionRecord[] = json.decisions ?? [];
        setNodeDecisions(ds);
        // Prefer a decision where this node IS the decision; else the first listed
        const selfDecision = ds.find(d => d.item_id === selectedNode.id) ?? ds[0];
        setActiveDecisionId(selfDecision?.id ?? null);
      } catch {
        setWorkstreams([]);
        setActiveWorkstreamId(null);
        setNodeDecisions([]);
        setActiveDecisionId(null);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedNode]);

  // Get connected nodes for the selected node
  const connectedNodes = useMemo(() => {
    if (!selectedNode) return [];

    const connected: { node: GraphNode; linkType: string; direction: 'from' | 'to' }[] = [];
    const nodeMap = new Map(graphData.nodes.map((n) => [n.id, n]));

    for (const edge of rawEdges) {
      if (edge.source_item_id === selectedNode.id) {
        const target = nodeMap.get(edge.target_item_id);
        if (target) connected.push({ node: target, linkType: edge.link_type, direction: 'to' });
      } else if (edge.target_item_id === selectedNode.id) {
        const source = nodeMap.get(edge.source_item_id);
        if (source) connected.push({ node: source, linkType: edge.link_type, direction: 'from' });
      }
    }

    // Sort chronologically
    connected.sort((a, b) => new Date(a.node.created_at).getTime() - new Date(b.node.created_at).getTime());
    return connected;
  }, [selectedNode, rawEdges, graphData.nodes]);

  // Get connected node IDs for hover highlighting
  const hoveredConnections = useMemo(() => {
    if (!hoveredNode) return new Set<string>();
    const ids = new Set<string>();
    for (const edge of rawEdges) {
      if (edge.source_item_id === hoveredNode.id) ids.add(edge.target_item_id);
      if (edge.target_item_id === hoveredNode.id) ids.add(edge.source_item_id);
    }
    return ids;
  }, [hoveredNode, rawEdges]);

  // Toggle source filter
  const toggleSource = useCallback((source: string) => {
    setSourceFilters((prev) => ({ ...prev, [source]: !prev[source] }));
  }, []);

  // Toggle type filter
  const toggleType = useCallback((type: string) => {
    setTypeFilters((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  // Node click handler
  const handleNodeClick = useCallback((node: any) => {
    setSelectedNode(node as GraphNode);
  }, []);

  // Node hover handler
  const handleNodeHover = useCallback((node: any) => {
    setHoveredNode(node as GraphNode | null);
  }, []);

  // Custom node renderer
  const nodeCanvasObject = useCallback((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const n = node as GraphNode;
    const label = truncate(n.title, 30);
    const fontSize = Math.max(10 / globalScale, 2);
    const nodeRadius = Math.max(Math.sqrt(n.val) * 2, 3);
    const isSelected = selectedNode?.id === n.id;
    const isHovered = hoveredNode?.id === n.id;
    const isConnected = hoveredNode ? hoveredConnections.has(n.id) : false;
    const isSearchMatch = searchHighlight.size > 0 && searchHighlight.has(n.id);
    const isDimmedByHover = hoveredNode && !isHovered && !isConnected && hoveredNode.id !== n.id;
    const isDimmedBySearch = searchHighlight.size > 0 && !isSearchMatch;
    const isDimmed = isDimmedByHover || isDimmedBySearch;

    const x = node.x || 0;
    const y = node.y || 0;

    // Search-match ring (drawn before selection ring so both show)
    if (isSearchMatch && !isSelected) {
      ctx.beginPath();
      ctx.arc(x, y, nodeRadius + 4, 0, 2 * Math.PI);
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2.5 / globalScale;
      ctx.stroke();
    }

    // Selection ring
    if (isSelected) {
      ctx.beginPath();
      ctx.arc(x, y, nodeRadius + 3, 0, 2 * Math.PI);
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 2 / globalScale;
      ctx.stroke();
    }

    // Hover ring
    if (isHovered) {
      ctx.beginPath();
      ctx.arc(x, y, nodeRadius + 2, 0, 2 * Math.PI);
      ctx.strokeStyle = '#999';
      ctx.lineWidth = 1.5 / globalScale;
      ctx.stroke();
    }

    // Node circle
    ctx.beginPath();
    ctx.arc(x, y, nodeRadius, 0, 2 * Math.PI);
    ctx.fillStyle = isDimmed ? `${n.color}44` : n.color;
    ctx.fill();

    // Label below — only show when zoomed in enough, or for hovered/selected nodes
    const showLabel = globalScale > 2.5 || isSelected || isHovered || (isConnected && globalScale > 1.2);
    if (showLabel) {
      const labelFontSize = Math.max(11 / globalScale, 2);
      ctx.font = `${labelFontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = isDimmed ? '#ccc' : (isSelected || isHovered) ? '#111' : '#555';
      ctx.fillText(label, x, y + nodeRadius + 2);
    }
  }, [selectedNode, hoveredNode, hoveredConnections, searchHighlight]);

  // Custom link renderer
  const linkCanvasObject = useCallback((link: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const sourceNode = link.source as GraphNode;
    const targetNode = link.target as GraphNode;
    if (!sourceNode.x || !sourceNode.y || !targetNode.x || !targetNode.y) return;

    const isHighlighted = hoveredNode && (
      (typeof link.source === 'object' && link.source.id === hoveredNode.id) ||
      (typeof link.target === 'object' && link.target.id === hoveredNode.id)
    );
    const isDimmed = hoveredNode && !isHighlighted;

    ctx.beginPath();
    ctx.moveTo(sourceNode.x, sourceNode.y);
    ctx.lineTo(targetNode.x, targetNode.y);
    ctx.strokeStyle = isDimmed ? '#eee' : (link.color || '#ddd');
    ctx.lineWidth = isHighlighted ? 2 / globalScale : 0.5 / globalScale;
    ctx.globalAlpha = isDimmed ? 0.2 : (isHighlighted ? 1 : 0.6);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }, [hoveredNode]);

  // Source counts
  const sourceCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const node of graphData.nodes) {
      counts[node.source] = (counts[node.source] || 0) + 1;
    }
    return counts;
  }, [graphData.nodes]);

  // Distinct sources present in data
  const availableSources = useMemo(() => {
    const sources = new Set<string>();
    for (const node of graphData.nodes) sources.add(node.source);
    return Array.from(sources);
  }, [graphData.nodes]);

  if (loading) {
    return (
      <div className="fixed inset-0 top-[52px] flex items-center justify-center bg-[#fafafa] z-10">
        <div className="flex items-center gap-3">
          <div className="w-4 h-4 rounded-full border-2 border-[#ddd] border-t-[#333] animate-spin" />
          <span className="text-[0.84rem] text-[#999]">Loading knowledge graph...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 top-[52px] flex bg-[#fafafa] overflow-hidden z-10">
      {/* Left Sidebar - Filters */}
      <div className="w-[240px] border-r border-black/[0.07] bg-white flex flex-col shrink-0 overflow-y-auto">
        <div className="px-5 pt-6 pb-4 border-b border-black/[0.07]">
          <h1 className="text-[1.1rem] font-bold tracking-tight text-black mb-[2px]">Knowledge Graph</h1>
          <p className="text-[0.72rem] text-[#999]">
            {filteredData.nodes.length} nodes &middot; {filteredData.links.length} edges
          </p>
        </div>

        {/* Semantic Search */}
        <div className="px-5 pt-3 pb-3 border-b border-black/[0.07]">
          <div className="text-[0.62rem] font-semibold uppercase tracking-[0.07em] text-[#999] mb-2">Search</div>
          <div className="relative">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Find across all sources..."
              className="w-full px-[10px] py-[6px] pr-7 text-[0.76rem] rounded-[6px] border border-black/[0.1] bg-white focus:outline-none focus:border-[#3b82f6] placeholder:text-[#bbb]"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 w-[18px] h-[18px] flex items-center justify-center text-[#bbb] hover:text-[#555] cursor-pointer"
                title="Clear"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
          {searching && (
            <div className="mt-2 text-[0.68rem] text-[#999]">Searching...</div>
          )}
          {!searching && searchResults.length > 0 && (
            <div className="mt-2">
              <div className="text-[0.66rem] text-[#999] mb-1">{searchResults.length} matches</div>
              <div className="flex flex-col gap-[3px] max-h-[240px] overflow-y-auto">
                {searchResults.slice(0, 20).map((hit) => {
                  const node = graphData.nodes.find((n) => n.id === hit.id);
                  return (
                    <button
                      key={hit.id}
                      onClick={() => node && setSelectedNode(node)}
                      className="text-left px-[8px] py-[5px] rounded-[5px] hover:bg-[#f5f5f5] transition-colors cursor-pointer border border-transparent hover:border-black/[0.07]"
                    >
                      <div className="flex items-center gap-[5px] mb-[1px]">
                        <div
                          className="w-[6px] h-[6px] rounded-full shrink-0"
                          style={{ backgroundColor: (hit.trace_role && traceRoleColors[hit.trace_role]) || sourceColors[hit.source] || '#999' }}
                        />
                        <span className="text-[0.62rem] text-[#999] uppercase">{sourceLabels[hit.source] || hit.source}</span>
                        {hit.trace_role && (
                          <span className="text-[0.58rem] px-[4px] py-px rounded-[3px]" style={{ backgroundColor: `${traceRoleColors[hit.trace_role]}15`, color: traceRoleColors[hit.trace_role] }}>
                            {traceRoleLabels[hit.trace_role] || hit.trace_role}
                          </span>
                        )}
                      </div>
                      <div className="text-[0.72rem] text-[#333] leading-[1.3] line-clamp-2">
                        {hit.title}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {!searching && searchQuery.trim().length >= 2 && searchResults.length === 0 && (
            <div className="mt-2 text-[0.68rem] text-[#999]">No matches</div>
          )}
        </div>

        {/* Recent Decisions */}
        {allDecisions.length > 0 && (
          <div className="px-5 pt-3 pb-3 border-b border-black/[0.07]">
            <div className="text-[0.62rem] font-semibold uppercase tracking-[0.07em] text-[#999] mb-2">
              Recent Decisions ({allDecisions.length})
            </div>
            <div className="flex flex-col gap-[3px] max-h-[220px] overflow-y-auto">
              {allDecisions.slice(0, 20).map((d) => {
                const node = graphData.nodes.find((n) => n.id === d.item_id);
                const statusColor = d.status === 'implemented' ? '#16a34a'
                                  : d.status === 'superseded' ? '#6b7280'
                                  : d.status === 'reversed' ? '#dc2626'
                                  : '#d97706';
                return (
                  <button
                    key={d.id}
                    onClick={() => node && setSelectedNode(node)}
                    className="text-left px-[8px] py-[5px] rounded-[5px] hover:bg-[#fef3c7] transition-colors cursor-pointer border border-transparent hover:border-[#f59e0b]/30"
                  >
                    <div className="flex items-center gap-[5px] mb-[1px]">
                      <div className="w-[6px] h-[6px] rounded-full shrink-0" style={{ backgroundColor: statusColor }} />
                      <span className="text-[0.6rem] text-[#999] tabular-nums">{d.decided_at.slice(0, 10)}</span>
                      <span className="text-[0.56rem] uppercase font-semibold" style={{ color: statusColor }}>{d.status}</span>
                      {d.generated_at && <span className="text-[0.56rem] text-[#bbb]" title="Has structured summary">•</span>}
                    </div>
                    <div className="text-[0.72rem] text-[#333] leading-[1.3] line-clamp-2">{d.title}</div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Source Filters */}
        <div className="px-5 pt-4 pb-3">
          <div className="text-[0.62rem] font-semibold uppercase tracking-[0.07em] text-[#999] mb-3">Sources</div>
          <div className="flex flex-col gap-[6px]">
            {availableSources.map((source) => (
              <label key={source} className="flex items-center gap-[8px] cursor-pointer group">
                <input
                  type="checkbox"
                  checked={sourceFilters[source] ?? true}
                  onChange={() => toggleSource(source)}
                  className="w-[14px] h-[14px] rounded-[3px] border border-black/[0.15] accent-black cursor-pointer"
                />
                <div
                  className="w-[8px] h-[8px] rounded-[2px]"
                  style={{ backgroundColor: sourceColors[source] || '#999' }}
                />
                <span className="text-[0.74rem] text-[#555] group-hover:text-black transition-colors flex-1">
                  {sourceLabels[source] || source}
                </span>
                <span className="text-[0.67rem] text-[#999] tabular-nums font-medium">
                  {sourceCounts[source] || 0}
                </span>
              </label>
            ))}
          </div>
        </div>

        {/* Status Filter */}
        <div className="px-5 pt-3 pb-3 border-t border-black/[0.07]">
          <div className="text-[0.62rem] font-semibold uppercase tracking-[0.07em] text-[#999] mb-3">Status</div>
          <div className="flex flex-wrap gap-[4px]">
            {statusOptions.map((status) => (
              <button
                key={status}
                onClick={() => setStatusFilter(status)}
                className={`px-[10px] py-[4px] rounded-[6px] text-[0.72rem] border transition-all cursor-pointer font-[inherit] ${
                  statusFilter === status
                    ? 'bg-black border-black text-white font-medium'
                    : 'bg-white border-black/[0.07] text-[#777] hover:border-black/[0.13] hover:text-[#333]'
                }`}
              >
                {status}
              </button>
            ))}
          </div>
        </div>

        {/* Type Filter */}
        {availableTypes.length > 0 && (
          <div className="px-5 pt-3 pb-4 border-t border-black/[0.07]">
            <div className="text-[0.62rem] font-semibold uppercase tracking-[0.07em] text-[#999] mb-3">Type</div>
            <div className="flex flex-wrap gap-[4px]">
              {availableTypes.map((type) => (
                <button
                  key={type}
                  onClick={() => toggleType(type)}
                  className={`px-[8px] py-[3px] rounded-[5px] text-[0.68rem] border transition-all cursor-pointer font-[inherit] ${
                    typeFilters.has(type)
                      ? 'bg-[#3b82f6] border-[#3b82f6] text-white font-medium'
                      : 'bg-white border-black/[0.07] text-[#777] hover:border-black/[0.13] hover:text-[#333]'
                  }`}
                >
                  {type}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Edge Legend */}
        <div className="px-5 pt-3 pb-4 border-t border-black/[0.07] mt-auto">
          <div className="text-[0.62rem] font-semibold uppercase tracking-[0.07em] text-[#999] mb-3">Edge Types</div>
          <div className="flex flex-col gap-[6px]">
            {Object.entries(linkTypeColors).map(([type, color]) => (
              <div key={type} className="flex items-center gap-[8px]">
                <div className="w-[16px] h-[2px] rounded-full" style={{ backgroundColor: color }} />
                <span className="text-[0.7rem] text-[#777]">{linkTypeLabels[type] || type}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Center - Graph */}
      <div ref={containerRef} className="flex-1 relative min-h-0 min-w-0 h-full">
        {filteredData.nodes.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <div className="text-[0.95rem] font-semibold text-[#555] mb-1">No nodes match your filters</div>
              <div className="text-[0.78rem] text-[#999]">Try adjusting the source or status filters</div>
            </div>
          </div>
        ) : (
          <ForceGraph2D
            ref={graphRef}
            graphData={filteredData}
            width={dimensions.width}
            height={dimensions.height}
            nodeCanvasObject={nodeCanvasObject}
            nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
              const radius = Math.max(Math.sqrt((node as GraphNode).val) * 2, 3) + 4;
              ctx.beginPath();
              ctx.arc(node.x || 0, node.y || 0, radius, 0, 2 * Math.PI);
              ctx.fillStyle = color;
              ctx.fill();
            }}
            linkCanvasObject={linkCanvasObject}
            onNodeClick={handleNodeClick}
            onNodeHover={handleNodeHover}
            onBackgroundClick={() => setSelectedNode(null)}
            d3AlphaDecay={0.02}
            d3VelocityDecay={0.2}
            warmupTicks={100}
            cooldownTicks={200}
            cooldownTime={5000}
            onEngineStop={() => {
              if (graphRef.current) {
                graphRef.current.zoomToFit(600, 80);
              }
            }}
            enableZoomInteraction={true}
            enablePanInteraction={true}
            backgroundColor="#fafafa"
          />
        )}
      </div>

      {/* Right Panel - Detail */}
      {selectedNode && (
        <div className="w-[360px] border-l border-black/[0.07] bg-white flex flex-col shrink-0 overflow-y-auto">
          {/* Header */}
          <div className="px-5 pt-5 pb-4 border-b border-black/[0.07]">
            <div className="flex items-start justify-between gap-2 mb-3">
              <h2 className="text-[0.92rem] font-semibold text-black leading-[1.35] flex-1">{selectedNode.title}</h2>
              <button
                onClick={() => setSelectedNode(null)}
                className="w-6 h-6 flex items-center justify-center rounded-[6px] text-[#999] hover:bg-[#f5f5f5] hover:text-black transition-all cursor-pointer shrink-0"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {/* Source + Status + trace_role badges */}
            <div className="flex items-center gap-[6px] flex-wrap mb-3">
              <Badge variant="source" className={`text-white`} style={{ backgroundColor: sourceColors[selectedNode.source] || '#999' }}>
                {sourceLabels[selectedNode.source] || selectedNode.source}
              </Badge>
              {selectedNode.source === 'jira' && (selectedNode.item_type === 'epic' || selectedNode.item_type === 'Epic') && (
                <Badge className="text-[0.63rem] font-semibold bg-[#7c3aed] text-white hover:bg-[#7c3aed]">
                  ★ Epic
                </Badge>
              )}
              {selectedNode.trace_role && (
                <Badge
                  className="text-[0.63rem] font-medium"
                  style={{
                    backgroundColor: `${traceRoleColors[selectedNode.trace_role] ?? '#999'}18`,
                    color: traceRoleColors[selectedNode.trace_role] ?? '#555',
                  }}
                >
                  {traceRoleLabels[selectedNode.trace_role] || selectedNode.trace_role}
                </Badge>
              )}
              {selectedNode.substance && (
                <Badge variant="outline" className="text-[0.63rem]">
                  {selectedNode.substance}
                </Badge>
              )}
              {selectedNode.status && (
                <Badge variant="secondary" className="text-[0.63rem]">
                  {selectedNode.status.replace('_', ' ')}
                </Badge>
              )}
              {selectedNode.item_type && (
                <Badge variant="outline" className="text-[0.63rem]">
                  {selectedNode.item_type}
                </Badge>
              )}
            </div>

            {/* Summary */}
            {selectedNode.summary && (
              <p className="text-[0.78rem] text-[#777] leading-[1.5] mb-3">{selectedNode.summary}</p>
            )}

            {/* Meta row */}
            <div className="flex items-center gap-3 flex-wrap text-[0.72rem] text-[#999]">
              {selectedNode.author && (
                <span>
                  by <span className="text-[#555] font-medium">{selectedNode.author}</span>
                </span>
              )}
              <span className="tabular-nums">{formatDate(selectedNode.created_at)}</span>
              {selectedNode.url && (
                <a
                  href={selectedNode.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#3b82f6] hover:underline underline-offset-2"
                >
                  Open source
                </a>
              )}
            </div>
          </div>

          {/* Tags */}
          {(selectedNode.topic_tags || selectedNode.goal_names || selectedNode.type_tag) && (
            <div className="px-5 pt-3 pb-3 border-b border-black/[0.07]">
              {selectedNode.type_tag && (
                <div className="mb-2">
                  <span className="text-[0.62rem] font-semibold uppercase tracking-[0.07em] text-[#999] mr-2">Type</span>
                  {selectedNode.type_tag.split(',').map((t) => (
                    <Badge key={t.trim()} className="mr-1 mb-1 bg-[rgba(59,130,246,0.08)] text-[#3b82f6] text-[0.63rem] hover:bg-[rgba(59,130,246,0.08)]">
                      {t.trim()}
                    </Badge>
                  ))}
                </div>
              )}
              {selectedNode.topic_tags && (
                <div className="mb-2">
                  <span className="text-[0.62rem] font-semibold uppercase tracking-[0.07em] text-[#999] mr-2">Topics</span>
                  {selectedNode.topic_tags.split(',').map((t) => (
                    <Badge key={t.trim()} variant="secondary" className="mr-1 mb-1 text-[0.63rem]">
                      {t.trim()}
                    </Badge>
                  ))}
                </div>
              )}
              {selectedNode.goal_names && (
                <div>
                  <span className="text-[0.62rem] font-semibold uppercase tracking-[0.07em] text-[#999] mr-2">Goals</span>
                  {selectedNode.goal_names.split(',').map((g) => (
                    <Badge key={g.trim()} className="mr-1 mb-1 bg-[rgba(26,135,84,0.08)] text-[#1a8754] text-[0.63rem] hover:bg-[rgba(26,135,84,0.08)]">
                      {g.trim()}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Decision Record (structured: Context / Decision / Rationale / Outcome / Status / Trace) */}
          {nodeDecisions.length > 0 && (
            <div className="px-5 pt-4 pb-4 border-b border-black/[0.07] bg-[#fffbeb]">
              <div className="flex items-center justify-between mb-3">
                <div className="text-[0.62rem] font-semibold uppercase tracking-[0.07em] text-[#d97706]">
                  Decision Record{nodeDecisions.length > 1 ? `s (${nodeDecisions.length})` : ''}
                </div>
                {nodeDecisions.length > 1 && (
                  <select
                    value={activeDecisionId ?? ''}
                    onChange={(e) => setActiveDecisionId(e.target.value)}
                    className="text-[0.65rem] px-[6px] py-[2px] border border-black/[0.1] rounded-[4px] bg-white cursor-pointer"
                  >
                    {nodeDecisions.map((d) => (
                      <option key={d.id} value={d.id}>{d.title.slice(0, 40)}</option>
                    ))}
                  </select>
                )}
              </div>
              {(() => {
                const d = nodeDecisions.find(x => x.id === activeDecisionId) ?? nodeDecisions[0];
                if (!d) return null;
                const s = d.summary;
                const statusColor = d.status === 'implemented' ? '#16a34a'
                                  : d.status === 'superseded' ? '#6b7280'
                                  : d.status === 'reversed' ? '#dc2626'
                                  : '#d97706';
                return (
                  <div className="flex flex-col gap-3">
                    <div className="text-[0.82rem] font-semibold text-[#111] leading-[1.35]">{d.title}</div>
                    <div className="flex items-center gap-[8px] text-[0.68rem]">
                      <span className="px-[6px] py-[1px] rounded-[3px] font-semibold uppercase" style={{ backgroundColor: `${statusColor}18`, color: statusColor }}>{d.status}</span>
                      <span className="text-[#999] tabular-nums">{d.decided_at.slice(0, 10)}</span>
                      {d.decided_by && <span className="text-[#999]">· by {d.decided_by}</span>}
                      {d.relation && d.relation !== 'self' && (
                        <span className="text-[0.62rem] px-[4px] py-px rounded-[3px] bg-[#e0e7ff] text-[#3730a3]">this item is: {d.relation}</span>
                      )}
                    </div>

                    {!s ? (
                      <div className="text-[0.74rem] text-[#999] italic">Structured summary not yet generated.</div>
                    ) : (
                      <div className="flex flex-col gap-[10px]">
                        <div>
                          <div className="text-[0.6rem] font-bold uppercase tracking-[0.08em] text-[#666] mb-1">Context</div>
                          <div className="text-[0.77rem] text-[#333] leading-[1.5]">{s.context}</div>
                        </div>
                        <div>
                          <div className="text-[0.6rem] font-bold uppercase tracking-[0.08em] text-[#666] mb-1">Decision</div>
                          <div className="text-[0.8rem] text-[#111] font-medium leading-[1.5] bg-white border-l-[3px] border-[#d97706] pl-3 py-1">{s.decision}</div>
                        </div>
                        <div>
                          <div className="text-[0.6rem] font-bold uppercase tracking-[0.08em] text-[#666] mb-1">Rationale</div>
                          <div className="text-[0.77rem] text-[#333] leading-[1.5]">{s.rationale}</div>
                        </div>

                        <div className="grid grid-cols-2 gap-3 bg-white rounded-md p-3 border border-black/[0.06]">
                          <div>
                            <div className="text-[0.58rem] font-bold uppercase tracking-[0.08em] text-[#2563eb] mb-1">What was asked</div>
                            <div className="text-[0.72rem] text-[#333] leading-[1.45]">{s.what_was_asked || '—'}</div>
                          </div>
                          <div>
                            <div className="text-[0.58rem] font-bold uppercase tracking-[0.08em] text-[#16a34a] mb-1">What was shipped</div>
                            <div className="text-[0.72rem] text-[#333] leading-[1.45]">{s.what_was_shipped || '—'}</div>
                          </div>
                        </div>
                        {s.gap_analysis && (
                          <div>
                            <div className="text-[0.6rem] font-bold uppercase tracking-[0.08em] text-[#666] mb-1">Gap analysis</div>
                            <div className="text-[0.74rem] text-[#333] leading-[1.5] italic">{s.gap_analysis}</div>
                          </div>
                        )}

                        {s.status_note && (
                          <div>
                            <div className="text-[0.6rem] font-bold uppercase tracking-[0.08em] text-[#666] mb-1">Status</div>
                            <div className="text-[0.77rem] text-[#333] leading-[1.5]">{s.status_note}</div>
                          </div>
                        )}

                        {[
                          { label: 'Discussion (JIRA / Notion / Slack / Meetings)', list: s.discussion_trace, accent: '#2563eb' },
                          { label: 'Implementation (GitHub)', list: s.implementation_trace, accent: '#16a34a' },
                        ].map(({ label, list, accent }) => (
                          list && list.length > 0 && (
                            <div key={label}>
                              <div className="flex items-center gap-2 mb-2">
                                <div className="w-[4px] h-[12px] rounded-sm" style={{ backgroundColor: accent }} />
                                <div className="text-[0.6rem] font-bold uppercase tracking-[0.08em]" style={{ color: accent }}>
                                  {label} ({list.length})
                                </div>
                              </div>
                              <div className="relative pl-4">
                                <div className="absolute left-[5px] top-[6px] bottom-[6px] w-px" style={{ backgroundColor: `${accent}33` }} />
                                {list.map((t, i) => {
                                  const roleColor = (t.role && traceRoleColors[t.role]) || accent;
                                  const isThis = t.item_id === selectedNode.id;
                                  return (
                                    <div
                                      key={`${t.item_id}-${i}`}
                                      className={`relative flex items-start gap-3 pb-2 last:pb-0 -mx-2 px-2 rounded-md ${isThis ? 'bg-white' : 'hover:bg-white cursor-pointer'}`}
                                      onClick={() => {
                                        if (isThis) return;
                                        const n = graphData.nodes.find(nn => nn.id === t.item_id);
                                        if (n) setSelectedNode(n);
                                      }}
                                    >
                                      <div className="absolute left-[-11px] top-[6px] w-[9px] h-[9px] rounded-full" style={{ backgroundColor: roleColor, outline: isThis ? '2px solid #3b82f6' : 'none', outlineOffset: '1px' }} />
                                      <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-[5px] mb-[1px]">
                                          <span className="text-[0.6rem] text-[#999] tabular-nums">{t.time}</span>
                                          <span className="text-[0.55rem] font-semibold px-[4px] py-px rounded-[3px]" style={{ backgroundColor: `${roleColor}18`, color: roleColor }}>{traceRoleLabels[t.role] || t.role}</span>
                                          <span className="text-[0.58rem] text-[#bbb]">{t.source}</span>
                                        </div>
                                        <div className="text-[0.73rem] text-[#222] leading-[1.35] font-medium">{t.title}</div>
                                        <div className="text-[0.68rem] text-[#666] leading-[1.35] mt-[1px]">{t.contribution}</div>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}

          {/* Workstreams (narrative + timeline) */}
          {workstreams.length > 0 && (
            <div className="px-5 pt-4 pb-4 border-b border-black/[0.07]">
              <div className="flex items-center justify-between mb-3">
                <div className="text-[0.62rem] font-semibold uppercase tracking-[0.07em] text-[#999]">
                  Workstream{workstreams.length > 1 ? `s (${workstreams.length})` : ''}
                </div>
                {workstreams.length > 1 && (
                  <select
                    value={activeWorkstreamId ?? ''}
                    onChange={(e) => setActiveWorkstreamId(e.target.value)}
                    className="text-[0.65rem] px-[6px] py-[2px] border border-black/[0.1] rounded-[4px] bg-white cursor-pointer"
                  >
                    {workstreams.map((w, i) => (
                      <option key={w.id} value={w.id}>WS {i + 1} · {w.timeline_events?.length || 0} items</option>
                    ))}
                  </select>
                )}
              </div>
              {(() => {
                const ws = workstreams.find(w => w.id === activeWorkstreamId) ?? workstreams[0];
                if (!ws) return null;
                return (
                  <div className="flex flex-col gap-3">
                    {ws.narrative ? (
                      <div className="text-[0.78rem] text-[#333] leading-[1.55] bg-[#fafafa] border border-black/[0.05] rounded-[6px] p-[10px]">
                        {ws.narrative}
                      </div>
                    ) : (
                      <div className="text-[0.74rem] text-[#999] italic">Narrative not yet generated. Run the pipeline to create one.</div>
                    )}
                    {ws.timeline_events?.length > 0 && (
                      <div className="relative pl-5">
                        <div className="absolute left-[7px] top-[6px] bottom-[6px] w-px bg-black/[0.1]" />
                        {ws.timeline_events.map((ev, i) => {
                          const isThis = ev.item_id === selectedNode.id;
                          const color = (ev.role && traceRoleColors[ev.role]) || '#999';
                          return (
                            <div
                              key={`${ev.item_id}-${i}`}
                              className={`relative flex items-start gap-3 pb-2 last:pb-0 -mx-2 px-2 rounded-md ${isThis ? 'bg-[#f5f7ff]' : 'hover:bg-[#f9f9f9] cursor-pointer'}`}
                              onClick={() => {
                                if (isThis) return;
                                const n = graphData.nodes.find(nn => nn.id === ev.item_id);
                                if (n) setSelectedNode(n);
                              }}
                            >
                              <div
                                className="absolute left-[-13px] top-[6px] w-[9px] h-[9px] rounded-full"
                                style={{ backgroundColor: color, outline: isThis ? '2px solid #3b82f6' : 'none', outlineOffset: '1px' }}
                              />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-[6px] mb-[1px]">
                                  <span className="text-[0.63rem] text-[#999] tabular-nums">{ev.time}</span>
                                  {ev.role && (
                                    <span
                                      className="text-[0.56rem] font-semibold px-[5px] py-px rounded-[3px]"
                                      style={{ backgroundColor: `${color}18`, color }}
                                    >
                                      {traceRoleLabels[ev.role] || ev.role}
                                    </span>
                                  )}
                                  <span className="text-[0.62rem] text-[#bbb]">{ev.source}</span>
                                </div>
                                <div className="text-[0.76rem] text-[#222] leading-[1.35] font-medium">{ev.title}</div>
                                {ev.one_liner && <div className="text-[0.7rem] text-[#666] leading-[1.35] mt-[2px]">{ev.one_liner}</div>}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}

          {/* Decision Trail */}
          <div className="px-5 pt-4 pb-4 border-b border-black/[0.07]">
            <div className="text-[0.62rem] font-semibold uppercase tracking-[0.07em] text-[#999] mb-3">
              Decision Trail ({connectedNodes.length})
            </div>
            {connectedNodes.length > 0 ? (
              <div className="relative pl-5">
                {/* Vertical timeline line */}
                <div className="absolute left-[7px] top-[6px] bottom-[6px] w-px bg-black/[0.1]" />

                {connectedNodes.map((conn, i) => (
                  <div
                    key={`${conn.node.id}-${i}`}
                    className="relative flex items-start gap-3 pb-3 last:pb-0 cursor-pointer hover:bg-[#f9f9f9] -mx-2 px-2 rounded-md transition-colors"
                    onClick={() => setSelectedNode(conn.node as GraphNode)}
                  >
                    {/* Dot on timeline */}
                    <div
                      className="absolute left-[-13px] top-[7px] w-[7px] h-[7px] rounded-full"
                      style={{ backgroundColor: linkTypeColors[conn.linkType] || '#ccc' }}
                    />

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-[2px]">
                        <span className="text-[0.65rem] text-[#999] tabular-nums">{formatDate(conn.node.created_at)}</span>
                        <span
                          className="text-[0.56rem] font-semibold px-[5px] py-px rounded-[3px]"
                          style={{
                            backgroundColor: `${linkTypeColors[conn.linkType] || '#ccc'}15`,
                            color: linkTypeColors[conn.linkType] || '#999',
                          }}
                        >
                          {conn.linkType} {conn.direction === 'from' ? 'from' : 'to'}
                        </span>
                      </div>
                      <div className="text-[0.78rem] text-[#333] leading-[1.4] truncate">{conn.node.title}</div>
                      <div className="flex items-center gap-[6px] mt-[2px]">
                        <div
                          className="w-[6px] h-[6px] rounded-[2px]"
                          style={{ backgroundColor: sourceColors[conn.node.source] || '#999' }}
                        />
                        <span className="text-[0.63rem] text-[#999]">
                          {sourceLabels[conn.node.source] || conn.node.source}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[0.78rem] text-[#999] text-center py-3">No connected items</div>
            )}
          </div>

          {/* Body content */}
          {selectedNode.body && (
            <div className="px-5 pt-4 pb-6 flex-1">
              <div className="text-[0.62rem] font-semibold uppercase tracking-[0.07em] text-[#999] mb-3">Content</div>
              <div className="max-h-[300px] overflow-y-auto">
                <Markdown>{selectedNode.body.length > 2000 ? selectedNode.body.slice(0, 2000) + '...' : selectedNode.body}</Markdown>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
