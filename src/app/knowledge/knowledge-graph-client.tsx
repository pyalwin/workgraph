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
  // force-graph props
  val: number;
  color: string;
  x?: number;
  y?: number;
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

        const nodes: GraphNode[] = data.nodes.map((item: any) => ({
          ...item,
          val: Math.max(2, (linkCountMap[item.id] || 0) * 2),
          color: sourceColors[item.source] || '#999',
        }));

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

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setDimensions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

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
    const isDimmed = hoveredNode && !isHovered && !isConnected && hoveredNode.id !== n.id;

    const x = node.x || 0;
    const y = node.y || 0;

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

    // Label below
    if (globalScale > 0.5) {
      ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = isDimmed ? '#ccc' : '#555';
      ctx.fillText(label, x, y + nodeRadius + 2);
    }
  }, [selectedNode, hoveredNode, hoveredConnections]);

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
      <div className="h-screen flex items-center justify-center bg-[#fafafa]">
        <div className="flex items-center gap-3">
          <div className="w-4 h-4 rounded-full border-2 border-[#ddd] border-t-[#333] animate-spin" />
          <span className="text-[0.84rem] text-[#999]">Loading knowledge graph...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex bg-[#fafafa] overflow-hidden">
      {/* Left Sidebar - Filters */}
      <div className="w-[240px] border-r border-black/[0.07] bg-white flex flex-col shrink-0 overflow-y-auto">
        <div className="px-5 pt-6 pb-4 border-b border-black/[0.07]">
          <h1 className="text-[1.1rem] font-bold tracking-tight text-black mb-[2px]">Knowledge Graph</h1>
          <p className="text-[0.72rem] text-[#999]">
            {filteredData.nodes.length} nodes &middot; {filteredData.links.length} edges
          </p>
        </div>

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
      <div ref={containerRef} className="flex-1 relative">
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
            d3AlphaDecay={0.05}
            d3VelocityDecay={0.3}
            warmupTicks={100}
            cooldownTicks={200}
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

            {/* Source + Status badges */}
            <div className="flex items-center gap-[6px] flex-wrap mb-3">
              <Badge variant="source" className={`text-white`} style={{ backgroundColor: sourceColors[selectedNode.source] || '#999' }}>
                {sourceLabels[selectedNode.source] || selectedNode.source}
              </Badge>
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
