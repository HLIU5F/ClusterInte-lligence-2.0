'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import * as d3 from 'd3';
import { Plus, Minus, RotateCcw } from 'lucide-react';
import type { TopologyNode, TopologyLink, TopologyData, GraphLayoutPreset, GraphPhysics } from '@/lib/types';
import { COMMUNITY_COLORS, getAnomalyLevel } from '@/lib/types';

interface TopologyGraphProps {
  data: TopologyData;
  edgeThreshold: number;
  nodeMinDegree: number;
  selectedNode: TopologyNode | null;
  highlightedCommunity: number | null;
  searchNodeId: string | null;
  showLabels: boolean;
  onNodeSelect: (node: TopologyNode | null) => void;
  highlightPathNodeIds?: string[];
  highlightPathEdges?: any[];
  layoutPreset: GraphLayoutPreset;
  physics: GraphPhysics;
  expansionNodes?: any[];
  expansionEdges?: any[];
  onExpandNeighbors?: (nodeId: string, hops: number) => void;
}

type SimNode = TopologyNode & d3.SimulationNodeDatum & { isExpanded?: boolean; distance?: number };
type SimLink = { source: SimNode; target: SimNode; weight: number; bytes: number };

export function TopologyGraph({
  data,
  edgeThreshold,
  nodeMinDegree,
  selectedNode,
  highlightedCommunity,
  searchNodeId,
  showLabels,
  onNodeSelect,
  layoutPreset,
  physics,
  expansionNodes = [],
  expansionEdges = [],
  onExpandNeighbors,
}: TopologyGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const simulationRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  // Handle resize
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setDimensions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Filter data
  const filteredData = useCallback(() => {
    const filteredNodes = data.nodes.filter(n => n.degree >= nodeMinDegree);
    const nodeIds = new Set(filteredNodes.map(n => n.id));

    const sortedLinks = [...data.links]
      .filter(l => {
        const srcId = typeof l.source === 'string' ? l.source : l.source.id;
        const tgtId = typeof l.target === 'string' ? l.target : l.target.id;
        return nodeIds.has(srcId) && nodeIds.has(tgtId);
      })
      .sort((a, b) => a.weight - b.weight);

    const cutoff = Math.floor(sortedLinks.length * edgeThreshold);
    const filteredLinks = sortedLinks.slice(cutoff);

    return { nodes: filteredNodes, links: filteredLinks };
  }, [data, edgeThreshold, nodeMinDegree]);

  // Main D3 rendering
  useEffect(() => {
    const svg = d3.select(svgRef.current);
    const { width, height } = dimensions;

    svg.selectAll('*').remove();

    const { nodes: rawNodes, links: rawLinks } = filteredData();
    if (rawNodes.length === 0) return;

    // Merge on-demand expanded neighbors into the visible graph
    const mergedRawNodes: (TopologyNode & { isExpanded?: boolean; distance?: number })[] = [...rawNodes];
    expansionNodes.forEach(en => {
      const existingIdx = mergedRawNodes.findIndex(n => n.id === en.id);
      if (existingIdx >= 0) {
        mergedRawNodes[existingIdx] = { ...mergedRawNodes[existingIdx], isExpanded: true, distance: en.distance };
      } else {
        mergedRawNodes.push({
          id: en.id,
          community: en.community ?? 0,
          degree: en.degree ?? 0,
          in_degree: en.in_degree ?? 0,
          out_degree: en.out_degree ?? 0,
          bytes_sent: en.bytes_sent ?? 0,
          bytes_received: en.bytes_received ?? 0,
          is_anomaly: en.is_anomaly ?? false,
          anomaly_score: en.anomaly_score ?? 0,
          anomaly_level: en.anomaly_level ?? getAnomalyLevel(en.anomaly_score ?? 0),
          role_guess: en.role_guess ?? 'Unknown',
          zone_label: en.zone_label,
          subnet_24: en.subnet_24,
          service_type: en.service_type,
          ports: en.ports ?? [],
          isExpanded: true,
          distance: en.distance,
        });
      }
    });
    const linkKeyOf = (l: any) => {
      const s = typeof l.source === 'string' ? l.source : l.source?.id ?? String(l.source);
      const t = typeof l.target === 'string' ? l.target : l.target?.id ?? String(l.target);
      return [s, t].sort().join('|');
    };
    const seenLinks = new Set(rawLinks.map(linkKeyOf));
    const mergedRawLinks = [...rawLinks];
    const mergedIds = new Set(mergedRawNodes.map(n => n.id));
    expansionEdges.forEach(e => {
      const srcId = e.source?.id ?? e.source;
      const tgtId = e.target?.id ?? e.target;
      if (!mergedIds.has(srcId) || !mergedIds.has(tgtId)) return;
      const key = [srcId, tgtId].sort().join('|');
      if (seenLinks.has(key)) return;
      seenLinks.add(key);
      mergedRawLinks.push({ source: srcId, target: tgtId, weight: e.weight ?? 1, bytes: e.bytes ?? 0 });
    });

    const nodes: SimNode[] = mergedRawNodes.map(n => ({ ...n }));
    const links: SimLink[] = mergedRawLinks.map(l => ({
      source: nodes.find(n => n.id === (typeof l.source === 'string' ? l.source : l.source.id))!,
      target: nodes.find(n => n.id === (typeof l.target === 'string' ? l.target : l.target.id))!,
      weight: l.weight,
      bytes: l.bytes,
    })).filter(l => l.source && l.target);

    // Create containers
    const g = svg.append('g').attr('class', 'topology-container');

    // Zoom behavior
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 8])
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
      });
    
    zoomRef.current = zoom;
    svg.call(zoom as any);

    // Arrow marker for directed edges
    const defs = g.append('defs');

    // Danger glow filter for anomaly nodes (#ff4d6a palette)
    const anomalyFilter = defs.append('filter')
      .attr('id', 'anomaly-glow')
      .attr('x', '-100%')
      .attr('y', '-100%')
      .attr('width', '300%')
      .attr('height', '300%');
    anomalyFilter.append('feGaussianBlur')
      .attr('in', 'SourceGraphic')
      .attr('stdDeviation', '4')
      .attr('result', 'blur');
    anomalyFilter.append('feColorMatrix')
      .attr('in', 'blur')
      .attr('type', 'matrix')
      .attr('values', '1 0 0 0 1  0 0.3 0 0 0.3  0 0 0.4 0 0.4  0 0 0 1 0')
      .attr('result', 'coloredBlur');
    const anomalyMerge = anomalyFilter.append('feMerge');
    anomalyMerge.append('feMergeNode').attr('in', 'coloredBlur');
    anomalyMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    // Primary glow filter (subtle, #00e5c7 cyan-teal)
    const glowFilter = defs.append('filter')
      .attr('id', 'node-glow')
      .attr('x', '-50%')
      .attr('y', '-50%')
      .attr('width', '200%')
      .attr('height', '200%');
    glowFilter.append('feGaussianBlur')
      .attr('in', 'SourceGraphic')
      .attr('stdDeviation', '2.5')
      .attr('result', 'blur');
    glowFilter.append('feColorMatrix')
      .attr('in', 'blur')
      .attr('type', 'matrix')
      .attr('values', '0 0 0 0 0  0 0.9 0 0 0.9  0 0 0.8 0 0.8  0 0 0 0.6 0')
      .attr('result', 'coloredBlur');
    const glowMerge = glowFilter.append('feMerge');
    glowMerge.append('feMergeNode').attr('in', 'coloredBlur');
    glowMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    // Selected node glow filter (strong primary glow, #00e5c7)
    const selectedGlowFilter = defs.append('filter')
      .attr('id', 'selected-node-glow')
      .attr('x', '-100%')
      .attr('y', '-100%')
      .attr('width', '300%')
      .attr('height', '300%');
    selectedGlowFilter.append('feGaussianBlur')
      .attr('in', 'SourceGraphic')
      .attr('stdDeviation', '5')
      .attr('result', 'blur');
    selectedGlowFilter.append('feColorMatrix')
      .attr('in', 'blur')
      .attr('type', 'matrix')
      .attr('values', '0 0 0 0 0  0 0.9 0 0 0.9  0 0 0.78 0 0.78  0 0 0 0.9 0')
      .attr('result', 'coloredBlur');
    const selectedMerge = selectedGlowFilter.append('feMerge');
    selectedMerge.append('feMergeNode').attr('in', 'coloredBlur');
    selectedMerge.append('feMergeNode').attr('in', 'coloredBlur');
    selectedMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    defs.append('marker')
      .attr('id', 'arrowhead')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 20)
      .attr('refY', 0)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', 'rgba(90,102,128,0.25)');

    // Weight scale for edge thickness
    const weightExtent = d3.extent(links, d => d.weight) as [number, number];
    const edgeWidthScale = d3.scaleLinear()
      .domain(weightExtent[0] === weightExtent[1] ? [0, weightExtent[1]] : weightExtent)
      .range([0.8, 3]);

    // Degree scale for node size - adaptive for large graphs
    const degreeExtent = d3.extent(nodes, d => d.degree) as [number, number];
    const isLargeGraph = nodes.length > 1000;
    const nodeSizeScale = d3.scaleLinear()
      .domain(degreeExtent[0] === degreeExtent[1] ? [0, degreeExtent[1]] : degreeExtent)
      .range(isLargeGraph ? [2, 8] : [4, 16]);

    // Edge opacity based on graph size
    const edgeOpacity = isLargeGraph ? 0.4 : 0.5;

    // Draw edges
    const linkGroup = g.append('g').attr('class', 'links');
    const linkElements = linkGroup.selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', d => (d as any).isCrossDomain ? 'rgba(0,229,199,0.15)' : 'rgba(90,102,128,0.25)')
      .attr('stroke-width', d => edgeWidthScale(d.weight))
      .attr('stroke-opacity', d => (d as any).isCrossDomain ? 0.5 : edgeOpacity)
      .attr('stroke-dasharray', d => (d as any).isCrossDomain ? '4,4' : 'none')
      .attr('stroke-linecap', 'round')
      .style('cursor', 'pointer')
      .classed('cross-domain', d => (d as any).isCrossDomain === true);

    // Edge hover interaction
    linkElements
      .on('mouseover', (event, d) => {
        const srcId = typeof d.source === 'object' ? d.source.id : d.source;
        const tgtId = typeof d.target === 'object' ? d.target.id : d.target;
        const isCrossDomain = (d as any).isCrossDomain;
        const ports = (d as any).ports || [];

        d3.select(event.currentTarget)
          .attr('stroke-opacity', 1)
          .attr('stroke-width', edgeWidthScale(d.weight) + 1);

        tooltip
          .style('opacity', '1')
          .style('left', `${event.offsetX + 15}px`)
          .style('top', `${event.offsetY - 10}px`)
          .html(`
            <div style="font-family: 'JetBrains Mono', monospace; font-size: 12px;">
              <div style="font-weight: 600; margin-bottom: 8px; color: ${isCrossDomain ? '#f0a030' : '#00e5c7'}; letter-spacing: 0.02em;">
                ${isCrossDomain ? '跨域连接' : '域内连接'} ×${d.weight}
              </div>
              <div style="display: grid; grid-template-columns: auto auto; gap: 3px 14px; font-size: 11px; line-height: 1.5;">
                <span style="color: #5a6680;">源节点</span>
                <span style="color: #e0e6f0;">${srcId}</span>
                <span style="color: #5a6680;">目标节点</span>
                <span style="color: #e0e6f0;">${tgtId}</span>
                <span style="color: #5a6680;">连接数</span>
                <span style="color: #e0e6f0; font-weight: 600;">${d.weight}</span>
                ${ports.length > 0 ? `
                  <span style="color: #5a6680;">端口</span>
                  <span style="color: #e0e6f0;">${ports.slice(0, 5).join(', ')}${ports.length > 5 ? ` +${ports.length - 5}` : ''}</span>
                ` : ''}
              </div>
            </div>
          `);
      })
      .on('mousemove', (event) => {
        tooltip
          .style('left', `${event.offsetX + 15}px`)
          .style('top', `${event.offsetY - 10}px`);
      })
      .on('mouseout', (event, d) => {
        d3.select(event.currentTarget)
          .attr('stroke-opacity', (d as any).isCrossDomain ? 0.5 : edgeOpacity)
          .attr('stroke-width', edgeWidthScale(d.weight));
        tooltip.style('opacity', '0');
      });

    // Edge count labels are now hidden by default, shown only in tooltip on hover
    // (Removed visible ×N labels to reduce visual clutter)

    // Draw node groups
    const nodeGroup = g.append('g').attr('class', 'nodes');
    const nodeElements = nodeGroup.selectAll<SVGGElement, SimNode>('g')
      .data(nodes)
      .join('g')
      .attr('class', 'node-group')
      .attr('tabindex', 0)
      .attr('role', 'button')
      .attr('aria-label', d => `节点 ${d.id}`)
      .style('cursor', 'pointer');

    // Anomaly node: animated red glow rings (SVG SMIL animations)
    // Skip whitelisted nodes
    nodeElements.filter(d => d.is_anomaly && !d.is_whitelisted).each(function(d) {
      const group = d3.select(this);
      const r = nodeSizeScale(d.degree);

      // Red glow background (pulsing)
      const glowBg = group.append('circle')
        .attr('r', r + 10)
        .attr('fill', '#ff4d6a')
        .attr('opacity', 0.1)
        .attr('filter', 'url(#anomaly-glow)');
      glowBg.append('animate')
        .attr('attributeName', 'opacity')
        .attr('values', '0.08;0.22;0.08')
        .attr('dur', '2s')
        .attr('repeatCount', 'indefinite');
      glowBg.append('animate')
        .attr('attributeName', 'r')
        .attr('values', `${r + 8};${r + 14};${r + 8}`)
        .attr('dur', '2s')
        .attr('repeatCount', 'indefinite');

      // Expanding ring 1
      const ring1 = group.append('circle')
        .attr('r', r + 2)
        .attr('fill', 'none')
        .attr('stroke', '#ff4d6a')
        .attr('stroke-width', 2.5)
        .attr('opacity', 0);
      ring1.append('animate')
        .attr('attributeName', 'r')
        .attr('values', `${r + 2};${r + 22}`)
        .attr('dur', '2s')
        .attr('repeatCount', 'indefinite');
      ring1.append('animate')
        .attr('attributeName', 'stroke-width')
        .attr('values', '2.5;0.3')
        .attr('dur', '2s')
        .attr('repeatCount', 'indefinite');
      ring1.append('animate')
        .attr('attributeName', 'opacity')
        .attr('values', '0.8;0')
        .attr('dur', '2s')
        .attr('repeatCount', 'indefinite');

      // Expanding ring 2 (delayed 1s)
      const ring2 = group.append('circle')
        .attr('r', r + 2)
        .attr('fill', 'none')
        .attr('stroke', '#ff4d6a')
        .attr('stroke-width', 2)
        .attr('opacity', 0);
      ring2.append('animate')
        .attr('attributeName', 'r')
        .attr('values', `${r + 2};${r + 20}`)
        .attr('dur', '2s')
        .attr('begin', '1s')
        .attr('repeatCount', 'indefinite');
      ring2.append('animate')
        .attr('attributeName', 'stroke-width')
        .attr('values', '2;0.2')
        .attr('dur', '2s')
        .attr('begin', '1s')
        .attr('repeatCount', 'indefinite');
      ring2.append('animate')
        .attr('attributeName', 'opacity')
        .attr('values', '0.6;0')
        .attr('dur', '2s')
        .attr('begin', '1s')
        .attr('repeatCount', 'indefinite');
    });

    // Normal node glow (background circle) - reduced for large graphs
    nodeElements.filter(d => !d.is_anomaly || d.is_whitelisted === true).append('circle')
      .attr('class', 'node-glow-circle')
      .attr('r', d => nodeSizeScale(d.degree) + (isLargeGraph ? 2 : 4))
      .attr('fill', d => COMMUNITY_COLORS[d.community % COMMUNITY_COLORS.length])
      .attr('opacity', d => {
        if (d.isFocusedDomain === false) return 0.05;
        return isLargeGraph ? 0.1 : 0.15;
      })
      .attr('filter', 'blur(3px)');

    // Node circle
    nodeElements.append('circle')
      .attr('class', 'node-circle')
      .attr('r', d => nodeSizeScale(d.degree))
      .attr('fill', d => COMMUNITY_COLORS[d.community % COMMUNITY_COLORS.length])
      .style('stroke', d => {
        if (d.is_anomaly && !d.is_whitelisted) return '#ff4d6a';
        if (d.isFocusedDomain === false) return 'rgba(0,0,0,0.3)';
        return 'rgba(0,0,0,0.6)';
      })
      .attr('stroke-width', d => {
        if (d.is_anomaly && !d.is_whitelisted) return 2.5;
        if (d.isFocusedDomain === false) return 0.5;
        return 1;
      })
      .attr('opacity', d => d.isFocusedDomain === false ? 0.3 : 0.9)
      .attr('filter', d => (d.is_anomaly && !d.is_whitelisted) ? 'url(#anomaly-glow)' : null);

    // Dashed ring marks nodes added by on-demand expansion
    nodeElements.filter(d => d.isExpanded === true).append('circle')
      .attr('class', 'node-expanded-ring')
      .attr('r', d => nodeSizeScale(d.degree) + 5)
      .attr('fill', 'none')
      .attr('stroke', 'var(--primary)')
      .attr('stroke-width', 1.25)
      .attr('stroke-dasharray', '3,3')
      .attr('opacity', 0.85);

    // Node labels - adaptive for large graphs
    const labelElements = nodeGroup.selectAll('text.node-label')
      .data(nodes)
      .join('text')
      .attr('class', 'node-label')
      .attr('text-anchor', 'middle')
      .attr('dy', d => nodeSizeScale(d.degree) + 12)
      .attr('fill', d => d.isFocusedDomain === false ? 'oklch(0.5 0.01 250 / 0.3)' : 'oklch(0.7 0.01 250)')
      .attr('font-size', isLargeGraph ? '8px' : '9px')
      .attr('font-family', "'JetBrains Mono', monospace")
      .attr('opacity', d => {
        if (d.isFocusedDomain === false) return 0;
        return showLabels && !isLargeGraph ? 0.8 : 0;
      })
      .text(d => d.id);

    // Tooltip
    const tooltip = d3.select(tooltipRef.current);

    nodeElements
      .on('mouseover', (event, d) => {
        const roleMap: Record<string, string> = {
          web_server: 'Web 服务', database: '数据库', cache: '缓存服务',
          message_queue: '消息队列', monitoring: '监控采集',
        };
        tooltip
          .style('opacity', '1')
          .style('left', `${event.offsetX + 15}px`)
          .style('top', `${event.offsetY - 10}px`)
          .html(`
            <div style="font-family: 'JetBrains Mono', monospace; font-size: 13px; font-weight: 600; color: #00e5c7; margin-bottom: 8px; letter-spacing: 0.02em;">
              ${d.id}
            </div>
            <div style="display: grid; grid-template-columns: auto auto; gap: 3px 14px; font-size: 11px; line-height: 1.5;">
              <span style="color: #5a6680;">角色</span>
              <span style="color: #e0e6f0;">${roleMap[d.role_guess] || d.role_guess}</span>
              <span style="color: #5a6680;">安全域</span>
              <span style="color: #e0e6f0;">Community ${d.community}</span>
              <span style="color: #5a6680;">连接数</span>
              <span style="color: #e0e6f0;">${d.degree} (入:${d.in_degree} 出:${d.out_degree})</span>
              <span style="color: #5a6680;">发送</span>
              <span style="color: #e0e6f0;">${formatBytes(d.bytes_sent)}</span>
              <span style="color: #5a6680;">接收</span>
              <span style="color: #e0e6f0;">${formatBytes(d.bytes_received)}</span>
              <span style="color: #5a6680;">异常分</span>
              <span style="color: ${d.is_anomaly && !d.is_whitelisted ? '#ff4d6a' : '#22d67a'}; font-weight: 600;">${d.anomaly_score.toFixed(3)} ${d.anomaly_level}</span>
            </div>
            ${d.is_whitelisted ? `<div style="color: #f0a030; margin-top: 6px; font-size: 11px;">⚠ 白名单节点：${d.whitelist_reason || '已加入白名单'}</div>` : ''}
          `);

        // Highlight node
        d3.select(event.currentTarget).select('.node-circle')
          .transition().duration(150)
          .attr('r', nodeSizeScale(d.degree) * 1.3)
          .attr('opacity', 1);
      })
      .on('mousemove', (event) => {
        tooltip
          .style('left', `${event.offsetX + 15}px`)
          .style('top', `${event.offsetY - 10}px`);
      })
      .on('mouseout', (event, d) => {
        tooltip.style('opacity', '0');
        d3.select(event.currentTarget).select('.node-circle')
          .transition().duration(150)
          .attr('r', nodeSizeScale(d.degree))
          .attr('opacity', 0.9);
      })
      .on('click', (_event, d) => {
        onNodeSelect(d);
        highlightNeighbors(d, nodes, links, nodeElements, linkElements);
      })
      .on('dblclick', (event, d) => {
        event.stopPropagation();
        onExpandNeighbors?.(d.id, 1);
      })
      .on('keydown', (event, d) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onNodeSelect(d);
          highlightNeighbors(d, nodes, links, nodeElements, linkElements);
        }
      });

    // Drag behavior
    const drag = d3.drag<SVGGElement, SimNode>()
      .on('start', (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });

    nodeElements.call(drag);

    // ── Force-directed layout (galaxy-style) ──
    const simulation = d3.forceSimulation<SimNode>(nodes)
      .force('link', d3.forceLink<SimNode, SimLink>(links)
        .id(d => d.id)
        .distance(physics.linkDistance)
        .strength(0.3))
      .force('collision', d3.forceCollide<SimNode>().radius(d => nodeSizeScale(d.degree) + physics.collideRadius));

    if (layoutPreset === 'radial') {
      const radius = Math.min(width, height) / 3;
      simulation
        .force('charge', d3.forceManyBody().strength(physics.chargeStrength * 0.8).distanceMax(500))
        .force('center', d3.forceCenter(width / 2, height / 2).strength(physics.centerStrength))
        .force('radial', d3.forceRadial(radius, width / 2, height / 2).strength(physics.centerStrength * 1.6));
    } else if (layoutPreset === 'community') {
      const communityIds = Array.from(new Set(nodes.map(n => n.community)));
      const communityCenters = new Map<number, { x: number; y: number }>();
      const ringRadius = Math.min(width, height) * 0.35;
      communityIds.forEach((cid, i) => {
        const angle = (i / Math.max(communityIds.length, 1)) * Math.PI * 2 - Math.PI / 2;
        communityCenters.set(cid, {
          x: width / 2 + Math.cos(angle) * ringRadius,
          y: height / 2 + Math.sin(angle) * ringRadius,
        });
      });
      simulation
        .force('charge', d3.forceManyBody().strength(physics.chargeStrength * 0.5).distanceMax(500))
        .force('center', d3.forceCenter(width / 2, height / 2).strength(0.1))
        .force('x', d3.forceX<SimNode>(d => communityCenters.get(d.community)?.x ?? width / 2).strength(physics.centerStrength * 0.8))
        .force('y', d3.forceY<SimNode>(d => communityCenters.get(d.community)?.y ?? height / 2).strength(physics.centerStrength * 0.8));
    } else {
      simulation
        .force('charge', d3.forceManyBody().strength(physics.chargeStrength).distanceMax(500))
        .force('center', d3.forceCenter(width / 2, height / 2).strength(physics.centerStrength * 0.15))
        .force('x', d3.forceX(width / 2).strength(0.02))
        .force('y', d3.forceY(height / 2).strength(0.02));
    }

    simulation.on('tick', () => {
      linkElements
        .attr('x1', d => d.source.x!)
        .attr('y1', d => d.source.y!)
        .attr('x2', d => d.target.x!)
        .attr('y2', d => d.target.y!);

      nodeElements
        .attr('transform', d => `translate(${d.x},${d.y})`);

      labelElements
        .attr('x', d => d.x!)
        .attr('y', d => d.y!);
    });

    simulationRef.current = simulation;

    // Initial zoom to fit
    simulation.on('end', () => {
      const bounds = (g.node() as SVGGElement)?.getBBox();
      if (bounds) {
        const dx = bounds.width;
        const dy = bounds.height;
        const cx = bounds.x + dx / 2;
        const cy = bounds.y + dy / 2;
        const scale = Math.min(0.9, 0.8 / Math.max(dx / width, dy / height));
        const translate = [width / 2 - scale * cx, height / 2 - scale * cy];

        svg.transition().duration(750).call(
          zoom.transform as never,
          d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale)
        );
      }
    });

    return () => {
      simulation.stop();
    };
  }, [data, dimensions, filteredData, showLabels, onNodeSelect, layoutPreset, expansionNodes, expansionEdges, onExpandNeighbors]);

  // Update force parameters without rebuilding the whole graph.
  useEffect(() => {
    const sim = simulationRef.current;
    if (!sim) return;
    const link = sim.force('link') as d3.ForceLink<SimNode, SimLink> | null;
    link?.distance(physics.linkDistance).strength(0.3);

    const collision = sim.force('collision') as d3.ForceCollide<SimNode> | null;
    if (collision) {
      const simNodes = sim.nodes();
      const degrees = simNodes.map(n => n.degree || 0);
      const extent = d3.extent(degrees) as [number, number];
      const scale = d3.scaleLinear()
        .domain(extent[0] === extent[1] ? [0, extent[1]] : extent)
        .range(simNodes.length > 1000 ? [2, 8] : [4, 16]);
      collision.radius(d => scale(d.degree || 0) + physics.collideRadius);
    }

    const chargeFactor = layoutPreset === 'radial' ? 0.8 : layoutPreset === 'community' ? 0.5 : 1;
    const charge = sim.force('charge') as d3.ForceManyBody<SimNode> | null;
    charge?.strength(physics.chargeStrength * chargeFactor);

    const center = sim.force('center') as d3.ForceCenter<SimNode> | null;
    if (center) {
      const centerStrength = layoutPreset === 'community' ? 0.1 : layoutPreset === 'radial' ? physics.centerStrength : physics.centerStrength * 0.15;
      center.strength(centerStrength);
    }

    sim.alpha(0.5).restart();
  }, [physics, layoutPreset]);

  // Handle community highlighting
  useEffect(() => {
    const svg = d3.select(svgRef.current);
    if (highlightedCommunity === null) {
      svg.selectAll('.node-group').attr('opacity', 1);
      svg.selectAll('.links line').attr('opacity', 1);
      return;
    }
    svg.selectAll('.node-group').attr('opacity', (d: unknown) => {
      const node = d as SimNode;
      return node.community === highlightedCommunity ? 1 : 0.1;
    });
    svg.selectAll('.links line').attr('opacity', (d: unknown) => {
      const link = d as SimLink;
      const srcCommunity = typeof link.source === 'object' ? link.source.community : -1;
      const tgtCommunity = typeof link.target === 'object' ? link.target.community : -1;
      return (srcCommunity === highlightedCommunity || tgtCommunity === highlightedCommunity) ? 1 : 0.05;
    });
  }, [highlightedCommunity]);

  // Handle search highlight
  useEffect(() => {
    if (!searchNodeId) return;
    const svg = d3.select(svgRef.current);
    const targetNode = svg.selectAll<SVGGElement, SimNode>('.node-group')
      .filter(d => d.id.includes(searchNodeId));

    if (!targetNode.empty()) {
      const nodeData = targetNode.datum();
      if (nodeData && nodeData.x != null && nodeData.y != null) {
        const container = svg.select('.topology-container');
        const currentTransform = d3.zoomTransform(svgRef.current!);
        const scale = Math.max(currentTransform.k, 1.5);

        svg.transition().duration(750).call(
          d3.zoom<SVGSVGElement, unknown>().transform as never,
          d3.zoomIdentity
            .translate(dimensions.width / 2, dimensions.height / 2)
            .scale(scale)
            .translate(-nodeData.x, -nodeData.y)
        );

        targetNode.classed('blink-node', true);
        setTimeout(() => targetNode.classed('blink-node', false), 3000);
      }
    }
  }, [searchNodeId, dimensions]);

  // Handle selected node highlight
  useEffect(() => {
    const svg = d3.select(svgRef.current);
    if (!selectedNode) {
      svg.selectAll('.node-group').attr('opacity', 1);
      svg.selectAll('.links line').attr('opacity', 1);
      return;
    }
    // Highlight is handled by click handler
  }, [selectedNode]);

  // Update labels visibility
  useEffect(() => {
    const svg = d3.select(svgRef.current);
    svg.selectAll('text.node-label')
      .transition().duration(300)
      .attr('opacity', showLabels ? 0.8 : 0);
  }, [showLabels]);

  return (
    <div ref={containerRef} className="relative w-full h-full topology-bg">
      <svg
        ref={svgRef}
        width={dimensions.width}
        height={dimensions.height}
        className="w-full h-full topology-svg"
      />
      <div ref={tooltipRef} className="topology-tooltip" style={{ opacity: 0 }} />

      {/* 缩放控件 */}
      <div className="absolute bottom-4 right-4 flex flex-col overflow-hidden rounded-lg backdrop-blur-xl bg-[var(--toolbar-bg)] border border-border/60 shadow-lg shadow-black/10">
        <button
          aria-label="放大"
          onClick={() => {
            if (!svgRef.current || !zoomRef.current) return;
            const svg = d3.select(svgRef.current);
            svg.transition().duration(300).call(zoomRef.current.scaleBy, 1.3);
          }}
          className="w-9 h-9 flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-primary/10 transition-[color,background-color,box-shadow] duration-200 hover:shadow-[0_0_12px_color-mix(in_srgb,var(--primary)_30%,transparent)]"
          title="放大"
        >
          <Plus className="w-4 h-4" />
        </button>
        <div className="h-px bg-border/60" />
        <button
          aria-label="缩小"
          onClick={() => {
            if (!svgRef.current || !zoomRef.current) return;
            const svg = d3.select(svgRef.current);
            svg.transition().duration(300).call(zoomRef.current.scaleBy, 0.7);
          }}
          className="w-9 h-9 flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-primary/10 transition-[color,background-color,box-shadow] duration-200 hover:shadow-[0_0_12px_color-mix(in_srgb,var(--primary)_30%,transparent)]"
          title="缩小"
        >
          <Minus className="w-4 h-4" />
        </button>
        <div className="h-px bg-border/60" />
        <button
          aria-label="重置视图"
          onClick={() => {
            if (!svgRef.current || !zoomRef.current || !dimensions.width || !dimensions.height) return;
            const svg = d3.select(svgRef.current);
            svg.transition().duration(500).call(
              zoomRef.current.transform,
              d3.zoomIdentity.translate(dimensions.width / 2, dimensions.height / 2).scale(0.8)
            );
          }}
          className="w-9 h-9 flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-primary/10 transition-[color,background-color,box-shadow] duration-200 hover:shadow-[0_0_12px_color-mix(in_srgb,var(--primary)_30%,transparent)]"
          title="重置视图"
        >
          <RotateCcw className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function highlightNeighbors(
  node: SimNode,
  nodes: SimNode[],
  links: SimLink[],
  nodeElements: d3.Selection<SVGGElement, SimNode, SVGGElement, unknown>,
  linkElements: d3.Selection<d3.BaseType, SimLink, SVGGElement, unknown>,
) {
  const neighborIds = new Set<string>();
  neighborIds.add(node.id);

  links.forEach(l => {
    const srcId = typeof l.source === 'object' ? l.source.id : String(l.source);
    const tgtId = typeof l.target === 'object' ? l.target.id : String(l.target);
    if (srcId === node.id) neighborIds.add(tgtId);
    if (tgtId === node.id) neighborIds.add(srcId);
  });

  nodeElements
    .attr('opacity', d => neighborIds.has(d.id) ? 1 : 0.1);

  linkElements
    .attr('opacity', d => {
      const srcId = typeof d.source === 'object' ? d.source.id : String(d.source);
      const tgtId = typeof d.target === 'object' ? d.target.id : String(d.target);
      return (srcId === node.id || tgtId === node.id) ? 1 : 0.03;
    })
    .style('stroke', d => {
      const srcId = typeof d.source === 'object' ? d.source.id : String(d.source);
      const tgtId = typeof d.target === 'object' ? d.target.id : String(d.target);
      return (srcId === node.id || tgtId === node.id)
        ? 'var(--primary)'
        : 'rgba(90,102,128,0.25)';
    });
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
