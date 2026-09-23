'use client';

import { useState, useMemo } from 'react';
import type { TopologyData, TopologyNode, TopologyLink } from '@/lib/types';
import { communityColor, ROLE_LABELS, ANOMALY_LEVEL_COLORS, formatBytes, formatNumber } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { ReachabilityPanel } from '@/components/reachability-panel';
import { getNodeCmdbTags } from '@/lib/cmdbTags';
import {
  Activity, AlertTriangle, Link2, ArrowRight,
  PanelRightClose, PanelRightOpen, ChevronRight,
  Server, Radar, Info, Network, X,
} from 'lucide-react';

interface InspectorPanelProps {
  selectedNode: TopologyNode | null;
  data: TopologyData | null;
  focusedCommunity: number | null;
  onNodeSelect: (node: TopologyNode | null) => void;
  onToggleFocus: (communityId: number | null) => void;
  onEnrichComplete?: (ip: string, result: any) => void;
  gdsAlgorithm?: 'louvain' | 'wcc' | 'original';
  gdsData?: { nodes: any[]; zones: any[]; hubNodes: any[] } | null;
}

type InspectorTab = 'detail' | 'reach' | 'connections';

export function InspectorPanel({
  selectedNode,
  data,
  focusedCommunity,
  onNodeSelect,
  onToggleFocus,
  gdsAlgorithm = 'original',
  gdsData = null,
}: InspectorPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [activeTab, setActiveTab] = useState<InspectorTab>('detail');

  // Compute effective community count based on GDS mode
  const effectiveCommunityCount = useMemo(() => {
    if (gdsAlgorithm !== 'original' && gdsData) {
      const zones = gdsData.zones.filter((z: any) => z.algorithm === gdsAlgorithm);
      const ids = new Set(zones.map((z: any) => z.community));
      return ids.size;
    }
    return data?.metadata.communities ?? 0;
  }, [gdsAlgorithm, gdsData, data]);

  // Collapsed state: just show a toggle button
  if (collapsed) {
    return (
      <div className="h-full flex flex-col items-center pt-2 w-11 glass-panel rounded-l-xl border-r-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setCollapsed(false)}
          className="h-8 w-8 p-0 text-muted-foreground hover:text-primary transition-colors"
          title="展开检查器面板"
        >
          <PanelRightOpen className="w-4 h-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="w-[400px] h-full flex flex-col glass-panel rounded-l-xl border-r-0 shadow-2xl">
      {/* Header */}
      <div className="px-3 py-2 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Info className="w-4 h-4 text-primary" />
          <span className="text-xs font-semibold tracking-tight">检查器</span>
        </div>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCollapsed(true)}
            className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
            title="折叠面板"
          >
            <PanelRightClose className="w-3.5 h-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onNodeSelect(null)}
            className="h-6 w-6 p-0 text-muted-foreground hover:text-[#ff4d6a]"
            title="关闭面板"
          >
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex border-b border-border">
        {[
          { key: 'detail' as const, label: '详情', icon: Activity },
          { key: 'reach' as const, label: '可达性', icon: Radar },
          { key: 'connections' as const, label: '连接', icon: Link2 },
        ].map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 flex items-center justify-center gap-1 py-2 text-xs font-medium transition-colors
              ${activeTab === tab.key
                ? 'text-primary border-b-2 border-primary bg-primary/5'
                : 'text-muted-foreground hover:text-foreground'
              }`}
          >
            <tab.icon className="w-3 h-3" />
            {tab.label}
          </button>
        ))}
      </div>

      <ScrollArea className="flex-1">
        {/* ===== Detail Tab ===== */}
        {activeTab === 'detail' && (
          <div className="p-3">
            {selectedNode && data ? (
              <NodeDetail node={selectedNode} data={data} onNodeSelect={onNodeSelect} />
            ) : (
              <div className="text-center py-12 text-muted-foreground">
                <Activity className="w-10 h-10 mx-auto mb-3 opacity-20" />
                <p className="text-xs mb-1">点击拓扑图中的节点</p>
                <p className="text-[11px]">查看详细信息</p>
                {data && (
                  <>
                    <Separator className="my-4" />
                    <div className="text-left space-y-2">
                      <div className="text-[11px] font-medium text-muted-foreground">
                        全局统计
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div className="rounded-md bg-secondary/30 px-2.5 py-2">
                          <div className="flex items-center gap-1.5 mb-1">
                            <Server className="w-3 h-3 text-muted-foreground" />
                            <span className="text-[10px] text-muted-foreground">节点</span>
                          </div>
                          <div className="text-sm font-semibold font-mono text-foreground">{formatNumber(data.nodes.length)}</div>
                        </div>
                        <div className="rounded-md bg-secondary/30 px-2.5 py-2">
                          <div className="flex items-center gap-1.5 mb-1">
                            <Link2 className="w-3 h-3 text-muted-foreground" />
                            <span className="text-[10px] text-muted-foreground">连接</span>
                          </div>
                          <div className="text-sm font-semibold font-mono text-foreground">{formatNumber(data.links.length)}</div>
                        </div>
                        <div className="rounded-md bg-secondary/30 px-2.5 py-2">
                          <div className="flex items-center gap-1.5 mb-1">
                            <Network className="w-3 h-3 text-muted-foreground" />
                            <span className="text-[10px] text-muted-foreground">安全域</span>
                          </div>
                          <div className="text-sm font-semibold font-mono text-foreground">{effectiveCommunityCount}{gdsAlgorithm !== 'original' && <span className="text-[11px] text-muted-foreground ml-1">({gdsAlgorithm.toUpperCase()})</span>}</div>
                        </div>
                        <div className="rounded-md bg-secondary/30 px-2.5 py-2">
                          <div className="flex items-center gap-1.5 mb-1">
                            <AlertTriangle className="w-3 h-3 text-destructive" />
                            <span className="text-[10px] text-muted-foreground">异常</span>
                          </div>
                          <div className="text-sm font-semibold font-mono text-destructive">
                            {formatNumber(data.nodes.filter(n => n.is_anomaly).length)}
                          </div>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* ===== Reachability Tab（横向可达性） ===== */}
        {activeTab === 'reach' && (
          <div className="p-3">
            <ReachabilityPanel
              selectedNodeId={selectedNode?.id || null}
              selectedNode={selectedNode}
              data={data}
              onNodeSelect={onNodeSelect}
            />
          </div>
        )}

        {/* ===== Connections Tab ===== */}
        {activeTab === 'connections' && (
          <div className="p-3">
            {selectedNode && data ? (
              <NodeConnections node={selectedNode} data={data} onNodeSelect={onNodeSelect} />
            ) : data && focusedCommunity !== null ? (
              <ConnectionList data={data} focusedCommunity={focusedCommunity} onNodeSelect={onNodeSelect} />
            ) : (
              <div className="text-center py-12 text-muted-foreground">
                <Link2 className="w-10 h-10 mx-auto mb-3 opacity-20" />
                {selectedNode ? (
                  <>
                    <p className="text-xs mb-1">选中节点的连接</p>
                    <p className="text-[11px]">将在上方显示</p>
                  </>
                ) : focusedCommunity !== null ? (
                  <>
                    <p className="text-xs mb-1">聚焦安全域 {focusedCommunity}</p>
                    <p className="text-[11px]">查看连接明细</p>
                  </>
                ) : (
                  <>
                    <p className="text-xs mb-1">选中节点或聚焦安全域</p>
                    <p className="text-[11px]">查看连接明细</p>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

// ============ Node Detail (migrated from sidebar) ============
function NodeDetail({ node, data, onNodeSelect }: {
  node: TopologyNode;
  data: TopologyData;
  onNodeSelect: (node: TopologyNode) => void;
}) {
  const neighbors = useMemo(() => {
    const neighborIds = new Set<string>();
    data.links.forEach(l => {
      const srcId = typeof l.source === 'string' ? l.source : l.source.id;
      const tgtId = typeof l.target === 'string' ? l.target : l.target.id;
      if (srcId === node.id) neighborIds.add(tgtId);
      if (tgtId === node.id) neighborIds.add(srcId);
    });
    return data.nodes.filter(n => neighborIds.has(n.id));
  }, [node, data]);

  const cmdbTags = getNodeCmdbTags(node);

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <div
            className="w-3 h-3 rounded-full"
            style={{ backgroundColor: communityColor(node.community) }}
          />
          <span className="text-sm font-mono font-semibold">{node.id}</span>
        </div>
        {node.is_anomaly && (
          <Badge variant="destructive" className="text-[10px]">
            <AlertTriangle className="w-3 h-3 mr-1" />
            {node.anomaly_level}
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <DetailRow label="角色" value={ROLE_LABELS[node.role_guess] || node.role_guess} />
        {node.is_critical && (
          <DetailRow label="资产属性" value="重要（关键服务）" tone="gold" />
        )}
        <DetailRow label="安全域" value={`安全域 ${node.community}`} />
        <DetailRow label="连接数" value={`${node.degree}`} />
        <DetailRow label="入/出" value={`${node.in_degree} / ${node.out_degree}`} />
        <DetailRow label="发送" value={formatBytes(node.bytes_sent)} />
        <DetailRow label="接收" value={formatBytes(node.bytes_received)} />
        <DetailRow label="异常分" value={node.anomaly_score.toFixed(3)} highlight={node.is_anomaly} />
      </div>

      {cmdbTags.length > 0 && (
        <>
          <Separator />
          <div>
            <div className="text-[11px] font-medium text-muted-foreground mb-1.5">
              CMDB 标签
            </div>
            <div className="flex flex-wrap gap-1.5">
              {cmdbTags.map(tag => (
                <Badge key={`${tag.key}-${tag.value}`} variant="outline" className="text-[10px]">
                  {tag.label}: {tag.value}
                </Badge>
              ))}
            </div>
          </div>
        </>
      )}

      <Separator />

      <div>
        <div className="text-[11px] font-medium text-muted-foreground mb-1.5">
          邻居节点 ({neighbors.length})
        </div>
        <div className="space-y-0.5 max-h-[200px] overflow-y-auto">
          {neighbors.slice(0, 20).map(n => (
            <div
              key={n.id}
              className="flex items-center gap-1.5 px-1.5 py-0.5 rounded text-[10px] hover:bg-secondary/50 cursor-pointer"
              onClick={() => onNodeSelect(n)}
            >
              <div
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: communityColor(n.community) }}
              />
              <span className="font-mono truncate">{n.id}</span>
              {n.is_anomaly && <AlertTriangle className="w-2.5 h-2.5 text-red-500 shrink-0" />}
            </div>
          ))}
          {neighbors.length > 20 && (
            <div className="text-[10px] text-muted-foreground text-center py-1">
              +{neighbors.length - 20} 更多...
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value, highlight, tone }: { label: string; value: string; highlight?: boolean; tone?: 'gold' }) {
  const color = tone === 'gold' ? 'text-amber-400' : highlight ? 'text-red-400' : '';
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono ${color}`}>{value}</span>
    </div>
  );
}

// ============ Node Connections (for selected node) ============
/**
 * 选中节点的连接明细。
 *
 * 不只是罗列边：每条连接都带出**对端的安全域、资产价值、角色**，并标出**跨域**。
 * 排序按「资产价值 → 连接度」，把最该先看的对端排在前面 ——
 * 排查横向移动时，"这台被拿下后能直接摸到哪个高价值资产" 比"有多少条边"重要得多。
 */
function NodeConnections({ node, data, onNodeSelect }: {
  node: TopologyNode;
  data: TopologyData;
  onNodeSelect: (node: TopologyNode) => void;
}) {
  const { outConns, inConns } = useMemo(() => {
    const byId = new Map(data.nodes.map(n => [n.id, n]));
    const out: Array<{ link: TopologyLink; peer?: TopologyNode }> = [];
    const inn: Array<{ link: TopologyLink; peer?: TopologyNode }> = [];
    for (const l of data.links) {
      const srcId = typeof l.source === 'string' ? l.source : (l.source as { id: string }).id;
      const tgtId = typeof l.target === 'string' ? l.target : (l.target as { id: string }).id;
      if (srcId === node.id) out.push({ link: l, peer: byId.get(tgtId) });
      else if (tgtId === node.id) inn.push({ link: l, peer: byId.get(srcId) });
    }
    const rank = (c: { peer?: TopologyNode }) =>
      (c.peer?.asset_value ?? 0) * 1000 + (c.peer?.degree ?? 0);
    out.sort((a, b) => rank(b) - rank(a));
    inn.sort((a, b) => rank(b) - rank(a));
    return { outConns: out, inConns: inn };
  }, [node, data]);

  const selfZone = node.zone_id ?? node.security_domain ?? null;
  const zoneOf = (n?: TopologyNode) => n?.zone_id ?? n?.security_domain ?? null;
  const crossOut = outConns.filter(c => zoneOf(c.peer) !== selfZone).length;
  const crossIn = inConns.filter(c => zoneOf(c.peer) !== selfZone).length;

  const renderRow = (conn: { link: TopologyLink; peer?: TopologyNode }, dir: 'out' | 'in') => {
    const ports = ((conn.link as unknown as { ports?: number[] }).ports) ?? [];
    const peer = conn.peer;
    const cross = zoneOf(peer) !== selfZone;
    const value = peer?.asset_value ?? null;
    return (
      <div
        key={`${dir}-${conn.link.source as string}-${conn.link.target as string}`}
        className={`text-[10px] p-1.5 rounded cursor-pointer transition-colors ${
          cross ? 'bg-destructive/10 border border-destructive/25 hover:bg-destructive/15' : 'bg-secondary/30 hover:bg-secondary/50'
        }`}
        onClick={() => peer && onNodeSelect(peer)}
        title={cross ? '跨安全域连接' : '同安全域'}
      >
        <div className="flex items-center gap-1">
          <span className="text-foreground truncate">{dir === 'out' ? node.id : (peer?.id ?? '?')}</span>
          <ArrowRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />
          <span className="text-foreground truncate">{dir === 'out' ? (peer?.id ?? '?') : node.id}</span>
          {value != null && value > 0 && (
            <span className={`ml-auto font-mono tabular-nums shrink-0 ${value >= 65 ? 'text-amber-400' : 'text-muted-foreground'}`}>
              {Number(value).toFixed(1)}
            </span>
          )}
        </div>
        <div className="text-[10px] text-muted-foreground mt-0.5 truncate">
          {peer?.zone_label || zoneOf(peer) || '未分区'}
          {' · '}
          {peer?.role_guess ? (ROLE_LABELS[peer.role_guess] || peer.role_guess) : '未知角色'}
          {peer?.degree != null ? ` · 度 ${peer.degree}` : ''}
        </div>
        {ports.length > 0 && (
          <div className="text-[10px] text-muted-foreground/80 mt-0.5 font-mono">
            端口 {ports.slice(0, 6).join(', ')}{ports.length > 6 ? ` +${ports.length - 6}` : ''}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-3">
      {/* 本节点概览 */}
      <div className="rounded-md bg-secondary/40 border border-border/60 px-3 py-2 space-y-1">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: communityColor(node.community) }} />
          <span className="text-xs font-mono font-semibold truncate">{node.id}</span>
          <Badge variant="secondary" className="text-[11px] ml-auto shrink-0">
            {outConns.length + inConns.length} 连接
          </Badge>
        </div>
        <div className="text-[11px] text-muted-foreground truncate">
          {node.zone_label || selfZone || '未分区'}
          {' · '}
          {node.role_guess ? (ROLE_LABELS[node.role_guess] || node.role_guess) : '未知角色'}
          {node.asset_value != null && ` · 资产价值 ${Number(node.asset_value).toFixed(1)}`}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-[11px]">
        <span className="px-2 py-1 rounded bg-secondary/40 text-muted-foreground">
          出向 {outConns.length}{crossOut > 0 && <span className="text-destructive">（跨域 {crossOut}）</span>}
        </span>
        <span className="px-2 py-1 rounded bg-secondary/40 text-muted-foreground">
          入向 {inConns.length}{crossIn > 0 && <span className="text-destructive">（跨域 {crossIn}）</span>}
        </span>
      </div>

      {outConns.length > 0 && (
        <div>
          <div className="text-[11px] text-muted-foreground font-medium mb-1.5 flex items-center gap-1">
            <div className="w-3 h-0.5 bg-muted-foreground/60 rounded" />
            出向连接（它在访问谁）
          </div>
          <div className="space-y-1 max-h-[240px] overflow-y-auto pr-1 scrollbar-thin">
            {outConns.map(c => renderRow(c, 'out'))}
          </div>
        </div>
      )}

      {inConns.length > 0 && (
        <div>
          <div className="text-[11px] text-muted-foreground font-medium mb-1.5 flex items-center gap-1">
            <div className="w-3 h-0.5 bg-muted-foreground/60 rounded" />
            入向连接（谁在访问它）
          </div>
          <div className="space-y-1 max-h-[240px] overflow-y-auto pr-1 scrollbar-thin">
            {inConns.map(c => renderRow(c, 'in'))}
          </div>
        </div>
      )}

      <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
        按「对端资产价值 → 连接度」排序；<span className="text-destructive">红色</span>为跨安全域连接。
        点击条目可在图上选中对端节点。
      </p>
    </div>
  );
}

// ============ Connection List (for focused community, migrated from sidebar) ============
function ConnectionList({ data, focusedCommunity, onNodeSelect }: {
  data: TopologyData;
  focusedCommunity: number | null;
  onNodeSelect: (node: TopologyNode) => void;
}) {
  if (!focusedCommunity) {
    return (
      <div className="text-center py-8">
        <Link2 className="w-8 h-8 text-muted-foreground mx-auto mb-2 opacity-50" />
        <p className="text-xs text-muted-foreground">请先聚焦一个安全域</p>
      </div>
    );
  }

  const domainNodeIds = new Set(
    data.nodes.filter(n => n.community === focusedCommunity).map(n => n.id)
  );

  const domainLinks = data.links.filter((link: TopologyLink) => {
    const sourceId = typeof link.source === 'object' ? (link.source as any).id : link.source;
    const targetId = typeof link.target === 'object' ? (link.target as any).id : link.target;
    return domainNodeIds.has(sourceId) || domainNodeIds.has(targetId);
  });

  if (domainLinks.length === 0) {
    return (
      <div className="text-center py-8">
        <Link2 className="w-8 h-8 text-muted-foreground mx-auto mb-2 opacity-50" />
        <p className="text-xs text-muted-foreground">该安全域暂无连接</p>
      </div>
    );
  }

  const internalLinks = domainLinks.filter((link: TopologyLink) => {
    const sourceId = typeof link.source === 'object' ? (link.source as any).id : link.source;
    const targetId = typeof link.target === 'object' ? (link.target as any).id : link.target;
    return domainNodeIds.has(sourceId) && domainNodeIds.has(targetId);
  });

  const crossDomainLinks = domainLinks.filter((link: TopologyLink) => {
    const sourceId = typeof link.source === 'object' ? (link.source as any).id : link.source;
    const targetId = typeof link.target === 'object' ? (link.target as any).id : link.target;
    return domainNodeIds.has(sourceId) !== domainNodeIds.has(targetId);
  });

  return (
    <div className="space-y-3">
      <div className="flex gap-2 text-[11px]">
        <span className="px-2 py-1 rounded bg-secondary/40 text-muted-foreground">
          域内 {internalLinks.length}
        </span>
        <span className="px-2 py-1 rounded bg-secondary/40 text-muted-foreground">
          跨域 {crossDomainLinks.length}
        </span>
        <span className="px-2 py-1 rounded bg-secondary/40 text-muted-foreground">
          总计 {domainLinks.length}
        </span>
      </div>

      {internalLinks.length > 0 && (
        <div>
          <div className="text-[11px] text-muted-foreground font-medium mb-1.5 flex items-center gap-1">
            <div className="w-3 h-0.5 bg-muted-foreground/60 rounded"></div>
            域内连接
          </div>
          <div className="space-y-1 max-h-[200px] overflow-y-auto pr-1 scrollbar-thin">
            {internalLinks.map((link, idx) => {
              const sourceId = typeof link.source === 'object' ? (link.source as any).id : link.source;
              const targetId = typeof link.target === 'object' ? (link.target as any).id : link.target;
              const ports = (link as any).ports || [];
              return (
                <div key={idx} className="text-[11px] p-1.5 rounded bg-secondary/30 font-mono">
                  <div className="flex items-center gap-1">
                    <span className="text-foreground truncate">{sourceId}</span>
                    <ArrowRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                    <span className="text-foreground truncate">{targetId}</span>
                  </div>
                  {ports.length > 0 && (
                    <div className="text-[11px] text-muted-foreground mt-0.5">
                      端口 {ports.slice(0, 5).join(', ')}{ports.length > 5 ? '...' : ''}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {crossDomainLinks.length > 0 && (
        <div>
          <div className="text-[11px] text-muted-foreground font-medium mb-1.5 flex items-center gap-1">
            <div className="w-3 h-0.5 bg-muted-foreground/60 rounded border-dashed border-t"></div>
            跨域连接
          </div>
          <div className="space-y-1 max-h-[200px] overflow-y-auto pr-1 scrollbar-thin">
            {crossDomainLinks.map((link, idx) => {
              const sourceId = typeof link.source === 'object' ? (link.source as any).id : link.source;
              const targetId = typeof link.target === 'object' ? (link.target as any).id : link.target;
              const isSourceInDomain = domainNodeIds.has(sourceId);
              const ports = (link as any).ports || [];
              return (
                <div key={idx} className="text-[11px] p-1.5 rounded bg-secondary/30 font-mono">
                  <div className="flex items-center gap-1">
                    <span className={isSourceInDomain ? 'text-foreground' : 'text-muted-foreground'}>
                      {sourceId}
                    </span>
                    <ArrowRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                    <span className={!isSourceInDomain ? 'text-foreground' : 'text-muted-foreground'}>
                      {targetId}
                    </span>
                  </div>
                  {ports.length > 0 && (
                    <div className="text-[11px] text-muted-foreground mt-0.5">
                      端口 {ports.slice(0, 5).join(', ')}{ports.length > 5 ? '...' : ''}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
