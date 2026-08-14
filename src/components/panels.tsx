"use client";

import { useState, useMemo } from 'react';
import type { TopologyData, TopologyNode, SecurityDomain, BaselineRule, BaselineViolation, NetworkStats, GDSHubNode, GdsRunInfo } from '@/lib/types';
import { COMMUNITY_COLORS, ANOMALY_LEVEL_COLORS, formatBytes, getAnomalyLevel } from '@/lib/types';
import type { ClusteringStrategy } from '@/lib/clustering';
import { CLUSTERING_LABELS, SECURITY_V3_GRANULARITY_LABELS } from '@/lib/clustering';
import type { SecurityV3Granularity } from '@/lib/clustering';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import {
  Search, Network, Tags, AlertTriangle, Activity, Eye,
  Upload, CheckCircle, Plus, X, TrendingUp, Route, Expand,
  ChevronDown, ChevronRight, Layers, Shield, ShieldCheck, AlertCircle, Database, Zap,
} from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { GDSPanel } from '@/components/gds-panel';
import { useVirtualRows } from '@/lib/useVirtualRows';

/* ============================================================
 * SHARED HELPER FUNCTIONS (Domain Naming)
 * ============================================================ */

function getDomainName(id: number, nodes: TopologyNode[]): string {
  if (nodes.length === 0) return `域 ${id} - 空`;
  const firstZoneLabel = nodes[0]?.zone_label;
  if (firstZoneLabel && firstZoneLabel !== 'Unassigned' && firstZoneLabel !== `Zone ${id}` && !firstZoneLabel.match(/^zone[_-]?\d+$/i)) {
    return `域 ${id} - ${firstZoneLabel}`;
  }
  const serviceTypeCounts = new Map<string, number>();
  nodes.forEach(n => {
    const st = n.service_type || n.role_guess || '';
    if (st && st !== '未知' && st !== 'unknown') serviceTypeCounts.set(st, (serviceTypeCounts.get(st) || 0) + 1);
  });
  if (serviceTypeCounts.size > 0) {
    const topService = Array.from(serviceTypeCounts.entries()).sort((a, b) => b[1] - a[1])[0][0];
    const SERVICE_LABELS: Record<string, string> = {
      'Web': 'Web 服务', 'DB': '数据库', 'Cache': '缓存服务',
      'RemoteAccess': '远程接入', 'MQ': '消息队列', 'DNS': 'DNS 服务',
      'Monitor': '监控采集', 'FileShare': '文件共享', 'Mail': '邮件服务',
    };
    return `域 ${id} - ${SERVICE_LABELS[topService] || topService}`;
  }
  const allPorts = new Set<number>();
  nodes.forEach(n => { if (n.ports) n.ports.forEach((p: number) => allPorts.add(p)); });
  if (allPorts.size > 0) {
    const hasWeb = [...allPorts].some(p => [80, 443, 8080, 8443].includes(p));
    const hasDB = [...allPorts].some(p => [3306, 5432, 1433, 27017, 6379].includes(p));
    const hasSSH = allPorts.has(22);
    const hasRDP = allPorts.has(3389);
    if (hasWeb && !hasDB) return `域 ${id} - Web 服务`;
    if (hasDB) return `域 ${id} - 数据库`;
    if (hasSSH || hasRDP) return `域 ${id} - 管理接入`;
    return `域 ${id} - 混合服务`;
  }
  const subnets = new Set<string>();
  nodes.forEach(n => { const s = n.subnet_24 || ''; if (s && s !== '0.0.0.0/0') subnets.add(s); });
  if (subnets.size === 1) return `域 ${id} - ${[...subnets][0]}`;
  if (subnets.size > 1 && subnets.size <= 3) return `域 ${id} - ${[...subnets].join(' / ')}`;
  return `域 ${id} - ${nodes.length} 节点`;
}

function getDomainDescription(nodes: TopologyNode[]): string {
  const anomalyCount = nodes.filter(n => n.is_anomaly).length;
  const serviceTypes = new Set<string>();
  nodes.forEach(n => { if (n.service_type && n.service_type !== '未知') serviceTypes.add(n.service_type); });
  const parts: string[] = [];
  if (serviceTypes.size > 0) parts.push([...serviceTypes].join('、'));
  if (anomalyCount > 0) parts.push(`${anomalyCount} 个异常`);
  return parts.length > 0 ? parts.join(' | ') : `${nodes.length} 个节点`;
}

function getGDSDomainName(algorithm: 'louvain' | 'wcc', id: number, nodes: TopologyNode[]): string {
  const prefix = algorithm === 'louvain' ? 'Louvain' : 'WCC';
  const serviceTypeCounts = new Map<string, number>();
  nodes.forEach(n => {
    const st = n.service_type || n.role_guess || '';
    if (st && st !== '未知' && st !== 'unknown') serviceTypeCounts.set(st, (serviceTypeCounts.get(st) || 0) + 1);
  });
  let serviceLabel = '';
  if (serviceTypeCounts.size > 0) {
    const topService = Array.from(serviceTypeCounts.entries()).sort((a, b) => b[1] - a[1])[0][0];
    const SERVICE_LABELS: Record<string, string> = {
      'Web': 'Web', 'DB': 'DB', 'Cache': 'Cache', 'RemoteAccess': '远程',
      'MQ': 'MQ', 'DNS': 'DNS', 'Monitor': '监控', 'FileShare': '文件', 'Mail': '邮件',
    };
    serviceLabel = SERVICE_LABELS[topService] || topService;
  }
  if (serviceLabel) return `${prefix} 域 ${id} - ${serviceLabel} (${nodes.length})`;
  return `${prefix} 域 ${id} (${nodes.length})`;
}

/* ============================================================
 * SHARED HELPER COMPONENTS
 * ============================================================ */

function DomainTopologyPreview({ nodes, links, color }: {
  nodes: TopologyNode[];
  links: any[];
  color: string;
}) {
  if (nodes.length === 0) return null;
  const W = 44, H = 30;
  const cx = W / 2, cy = H / 2;
  const r = Math.min(W, H) / 2 - 3;
  const positions = nodes.map((_, i) => {
    const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  });
  const nodeIndex = new Map(nodes.map((n, i) => [n.id, i]));
  const edgeLines: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  links.forEach(l => {
    const srcId = typeof l.source === 'string' ? l.source : l.source?.id;
    const tgtId = typeof l.target === 'string' ? l.target : l.target?.id;
    const si = nodeIndex.get(srcId);
    const ti = nodeIndex.get(tgtId);
    if (si !== undefined && ti !== undefined) {
      edgeLines.push({ x1: positions[si].x, y1: positions[si].y, x2: positions[ti].x, y2: positions[ti].y });
    }
  });
  const nodeR = nodes.length > 20 ? 1 : nodes.length > 10 ? 1.3 : 1.8;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0 opacity-70">
      {edgeLines.map((e, i) => (
        <line key={`e${i}`} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
          stroke="var(--primary)" strokeOpacity={0.15} strokeWidth={0.5} />
      ))}
      {positions.map((p, i) => (
        <circle key={`n${i}`} cx={p.x} cy={p.y} r={nodeR}
          fill={color} opacity={0.9}
          style={{ filter: `drop-shadow(0 0 2px ${color})` }} />
      ))}
    </svg>
  );
}

function VirtualizedDomainList({ domains, data, focusedCommunity, onToggleFocus, onHighlightCommunity }: {
  domains: SecurityDomain[];
  data: TopologyData | null;
  focusedCommunity: number | null;
  onToggleFocus: (id: number) => void;
  onHighlightCommunity: (id: number | null) => void;
}) {
  const { containerRef, visible, start, totalHeight, rowHeight } = useVirtualRows(domains, 56, 6);
  return (
    <div ref={containerRef} className="relative max-h-[35vh] overflow-y-auto pr-1 scrollbar-thin">
      <div style={{ height: totalHeight, position: 'relative' }}>
        {visible.map((domain, i) => {
          const index = start + i;
          const domainNodes = data?.nodes.filter(n => n.community === domain.id) || [];
          const domainLinks = data?.links.filter(l => {
            const srcId = typeof l.source === 'string' ? l.source : l.source.id;
            const tgtId = typeof l.target === 'string' ? l.target : l.target.id;
            const srcNode = data?.nodes.find(n => n.id === srcId);
            const tgtNode = data?.nodes.find(n => n.id === tgtId);
            return srcNode?.community === domain.id && tgtNode?.community === domain.id;
          }) || [];
          return (
            <div
              key={domain.id}
              className={`absolute left-0 right-0 flex items-center gap-2 pl-3 pr-2 py-2 rounded-lg transition-colors group cursor-pointer overflow-hidden ${
                focusedCommunity === domain.id
                  ? 'bg-primary/10 border border-primary/35 shadow-[0_0_12px_color-mix(in_srgb,var(--primary)_12%,transparent)]'
                  : 'bg-secondary/40 border border-border/60 hover:border-primary/40 hover:shadow-[0_0_10px_color-mix(in_srgb,var(--primary)_10%,transparent)]'
              }`}
              style={{ top: index * rowHeight, height: rowHeight }}
              onClick={() => onToggleFocus(domain.id)}
              onMouseEnter={() => onHighlightCommunity(domain.id)}
              onMouseLeave={() => onHighlightCommunity(null)}
            >
              <div
                className="absolute left-0 top-0 bottom-0 w-[3px]"
                style={{
                  backgroundColor: domain.avgAnomalyScore > 0.5 ? '#ff4d6a' : domain.color,
                  boxShadow: domain.avgAnomalyScore > 0.5
                    ? '0 0 8px rgba(255,77,106,0.5)'
                    : `0 0 6px ${domain.color}40`,
                }}
              />
              <div
                className="w-2.5 h-2.5 rounded-full shrink-0 ml-1"
                style={{ backgroundColor: domain.color }}
              />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium truncate">{domain.name}</div>
                <div className="text-[10px] text-muted-foreground">
                  {domain.nodeCount} 节点 | {domain.linkCount} 连接
                </div>
              </div>
              <DomainTopologyPreview nodes={domainNodes} links={domainLinks} color={domain.color} />
              {domain.avgAnomalyScore > 0.3 && (
                <AlertCircle className="w-3 h-3 text-amber-500 shrink-0" />
              )}
              {focusedCommunity === domain.id && (
                <Eye className="w-3 h-3 text-primary shrink-0" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PathQueryForm({ onQuery, hasResult, pathLength }: {
  onQuery?: (source: string, target: string) => void;
  hasResult: boolean;
  pathLength: number;
}) {
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [queryLoading, setQueryLoading] = useState(false);
  const handleSubmit = async () => {
    if (!source.trim() || !target.trim()) return;
    setQueryLoading(true);
    try { await onQuery?.(source.trim(), target.trim()); }
    finally { setQueryLoading(false); }
  };
  return (
    <div className="space-y-2">
      <Input
        aria-label="源 IP"
        name="path-source"
        autoComplete="off"
        placeholder="源 IP (如 10.0.1.5)"
        value={source}
        onChange={(e) => setSource(e.target.value)}
        className="h-8 text-[11px] font-mono bg-muted/50 border-border/70 backdrop-blur-sm focus:border-primary/60 focus:ring-0 placeholder:text-muted-foreground/70"
      />
      <Input
        aria-label="目标 IP"
        name="path-target"
        autoComplete="off"
        placeholder="目标 IP (如 10.0.3.10)"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        className="h-8 text-[11px] font-mono bg-muted/50 border-border/70 backdrop-blur-sm focus:border-primary/60 focus:ring-0 placeholder:text-muted-foreground/70"
      />
      <Button
        size="sm"
        className="w-full h-8 text-[11px] font-medium"
        style={{
          background: 'linear-gradient(135deg, color-mix(in srgb, var(--primary) 22%, transparent), color-mix(in srgb, var(--primary) 6%, transparent))',
          border: '1px solid color-mix(in srgb, var(--primary) 32%, transparent)',
          color: 'var(--primary)',
        }}
        onClick={handleSubmit}
        disabled={queryLoading || !source.trim() || !target.trim()}
      >
        {queryLoading ? '查询中…' : '查询路径'}
      </Button>
      {hasResult && (
        <div className="text-[10px] text-primary">找到路径: {pathLength} 个节点</div>
      )}
    </div>
  );
}

function NeighborExpansion({ selectedNodeId, onExpand, expansionNodeCount }: {
  selectedNodeId: string | null;
  onExpand?: (nodeId: string, hops: number) => void;
  expansionNodeCount: number;
}) {
  const [hops, setHops] = useState(2);
  return (
    <div className="space-y-2">
      {selectedNodeId ? (
        <>
          <div className="text-[10px] text-muted-foreground">
            从节点 <span className="font-mono text-foreground">{selectedNodeId}</span> 扩展
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">跳数:</span>
            {[1, 2, 3].map(h => (
              <button
                key={h}
                onClick={() => setHops(h)}
                className={`w-7 h-7 rounded-full text-[10px] font-mono transition-colors duration-200 ${
                  hops === h
                    ? 'bg-primary/15 text-primary border border-primary/40 shadow-[0_0_8px_color-mix(in_srgb,var(--primary)_20%,transparent)]'
                    : 'bg-secondary/40 text-muted-foreground border border-border/70 hover:border-primary/40 hover:text-foreground'
                }`}
              >
                {h}
              </button>
            ))}
          </div>
          <Button
            size="sm"
            className="w-full h-8 text-[11px] font-medium"
            style={{
              background: 'linear-gradient(135deg, color-mix(in srgb, var(--primary) 22%, transparent), color-mix(in srgb, var(--primary) 6%, transparent))',
              border: '1px solid color-mix(in srgb, var(--primary) 32%, transparent)',
              color: 'var(--primary)',
            }}
            onClick={() => onExpand?.(selectedNodeId, hops)}
          >
            扩展 {hops} 跳邻居
          </Button>
          {expansionNodeCount > 0 && (
            <div className="text-[10px] text-success">已扩展 {expansionNodeCount} 个邻居节点</div>
          )}
        </>
      ) : (
        <div
          className="text-[10px] text-muted-foreground text-center py-3 rounded-lg"
          style={{
            border: '1px dashed var(--border)',
            background: 'color-mix(in srgb, var(--muted) 50%, transparent)',
          }}
        >
          选中一个节点后，可扩展其 N 跳邻居
        </div>
      )}
    </div>
  );
}

function BaselineRuleItem({ rule, violationCount, onToggle }: {
  rule: BaselineRule;
  violationCount: number;
  onToggle: () => void;
}) {
  const fieldLabels: Record<string, string> = {
    anomaly_score: '异常分数', bytes_sent: '发送字节',
    bytes_received: '接收字节', degree: '连接数', port_entropy: '端口熵',
  };
  const operatorLabels: Record<string, string> = { gt: '>', lt: '<', eq: '=', between: '范围' };
  return (
    <div
      className={`relative overflow-hidden rounded-lg px-2.5 py-2 ${rule.enabled ? '' : 'opacity-50'}`}
      style={{
        background: 'color-mix(in srgb, var(--muted) 60%, transparent)',
        border: '1px solid var(--border)',
      }}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] font-medium">{rule.name}</span>
        <button onClick={onToggle} className="text-[10px] text-muted-foreground hover:text-foreground">
          {rule.enabled ? 'ON' : 'OFF'}
        </button>
      </div>
      <div className="text-[10px] text-muted-foreground">
        {fieldLabels[rule.field]} {operatorLabels[rule.operator]} {rule.threshold}
        {rule.operator === 'between' ? ` ~ ${rule.thresholdMax}` : ''}
      </div>
      {violationCount > 0 && (
        <Badge variant="destructive" className="mt-1 text-[11px] px-1.5 py-0">{violationCount} 违规</Badge>
      )}
    </div>
  );
}

/* ============================================================
 * File Import Utility (shared)
 * ============================================================ */

function processImportedJSON(json: any, fileName: string): any {
  if (json.nodes && json.links) {
    json.nodes = json.nodes.map((n: TopologyNode) => ({
      ...n,
      anomaly_level: n.anomaly_level || getAnomalyLevel(n.anomaly_score),
      is_anomaly: n.is_whitelisted ? false : (n.is_anomaly ?? (n.anomaly_score > 0.6 || n.anomaly_level === 'Critical' || n.anomaly_level === 'High')),
    }));
    if (!json.metadata) {
      json.metadata = {
        generated_at: new Date().toISOString().split('T')[0],
        source: fileName,
        total_nodes: json.nodes.length,
        total_links: json.links.length,
        communities: new Set(json.nodes.map((n: TopologyNode) => n.community)).size,
      };
    } else {
      json.metadata = {
        ...json.metadata,
        total_nodes: json.nodes.length,
        total_links: json.links.length,
        communities: new Set(json.nodes.map((n: TopologyNode) => n.community)).size,
      };
    }
    return json;
  }
  return null;
}

/* ============================================================
 * 📂 DataSourcePanel — 数据源管理
 * ============================================================ */

interface DataSourcePanelProps {
  onImportData: (data: TopologyData) => void;
  onLoadFromNeo4j?: () => void;
  onLoadBusinessModel?: () => void;
  loading?: boolean;
  data: TopologyData | null;
}

export function DataSourcePanel({ onImportData, onLoadFromNeo4j, onLoadBusinessModel, loading, data }: DataSourcePanelProps) {
  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const isExcel = file.name.endsWith('.xlsx') || file.name.endsWith('.xls');
    const isJSON = file.name.endsWith('.json');
    if (isExcel) {
      try {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch('/api/import', { method: 'POST', body: formData });
        const result = await res.json();
        if (result.success && result.data) {
          onImportData(result.data);
        } else {
          alert(`导入失败: ${result.error || '未知错误'}`);
        }
      } catch {
        alert('文件上传失败，请检查网络');
      }
    } else if (isJSON) {
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const json = JSON.parse(event.target?.result as string);
          const processed = processImportedJSON(json, file.name);
          if (processed) {
            onImportData(processed);
          } else {
            alert('JSON 格式不正确，需要包含 nodes 和 links 字段');
          }
        } catch {
          alert('JSON 解析失败，请检查文件格式');
        }
      };
      reader.readAsText(file);
    } else {
      alert('不支持的文件格式，请上传 .xlsx 或 .json 文件');
    }
    e.target.value = '';
  };

  return (
    <div className="space-y-4">
      {/* File Import */}
      <div>
        <div className="flex items-center gap-1.5 mb-3">
          <Upload className="w-3.5 h-3.5 text-primary" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">本地文件导入</span>
        </div>
        <label className="flex flex-col items-center justify-center gap-2 w-full h-24 rounded-lg border border-dashed border-border/60 hover:border-primary/50 hover:bg-primary/5 cursor-pointer transition-colors">
          <Upload className="w-5 h-5 text-muted-foreground" />
          <span className="text-[11px] text-muted-foreground">导入 Excel / JSON 文件</span>
          <span className="text-[11px] text-muted-foreground/60">支持 .xlsx, .xls, .json</span>
          <input type="file" accept=".json,.xlsx,.xls" className="hidden" onChange={handleFileImport} />
        </label>
      </div>

      {/* Neo4j */}
      <div>
        <div className="flex items-center gap-1.5 mb-3">
          <Database className="w-3.5 h-3.5 text-warning" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Neo4j 数据库</span>
        </div>
        {onLoadFromNeo4j && (
          <Button
            onClick={onLoadFromNeo4j}
            disabled={loading}
            size="sm"
            className="w-full h-9 text-[11px] font-medium"
            style={{
              background: 'linear-gradient(135deg, color-mix(in srgb, var(--warning) 18%, transparent), color-mix(in srgb, var(--warning) 6%, transparent))',
              border: '1px solid color-mix(in srgb, var(--warning) 30%, transparent)',
              color: 'var(--warning)',
            }}
          >
            <Database className="w-3.5 h-3.5 mr-1.5" />
            {loading ? '连接中…' : '从 Neo4j 加载数据'}
          </Button>
        )}
      </div>

      {/* Business model */}
      {onLoadBusinessModel && (
        <div>
          <div className="flex items-center gap-1.5 mb-3">
            <Network className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">业务建模数据</span>
          </div>
          <Button
            onClick={onLoadBusinessModel}
            disabled={loading}
            size="sm"
            className="w-full h-9 text-[11px] font-medium"
            style={{
              background: 'linear-gradient(135deg, color-mix(in srgb, #10b981 18%, transparent), color-mix(in srgb, #10b981 6%, transparent))',
              border: '1px solid color-mix(in srgb, #10b981 30%, transparent)',
              color: 'var(--success)',
            }}
          >
            <Network className="w-3.5 h-3.5 mr-1.5" />
            {loading ? '加载中…' : '加载业务建模数据'}
          </Button>
        </div>
      )}

      {/* Data source info */}
      {data && (
        <>
          <Separator />
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Activity className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">当前数据源</span>
            </div>
            <div className="rounded-lg p-3 space-y-2" style={{ background: 'color-mix(in srgb, var(--muted) 60%, transparent)', border: '1px solid var(--border)' }}>
              <div className="flex justify-between text-[11px]">
                <span className="text-muted-foreground">来源</span>
                <span className="font-mono text-foreground">{data.metadata.source}</span>
              </div>
              <div className="flex justify-between text-[11px]">
                <span className="text-muted-foreground">生成时间</span>
                <span className="font-mono text-foreground">{data.metadata.generated_at}</span>
              </div>
              <div className="flex justify-between text-[11px]">
                <span className="text-muted-foreground">节点数</span>
                <span className="font-mono text-primary">{data.metadata.total_nodes}</span>
              </div>
              <div className="flex justify-between text-[11px]">
                <span className="text-muted-foreground">连接数</span>
                <span className="font-mono text-primary">{data.metadata.total_links}</span>
              </div>
              <div className="flex justify-between text-[11px]">
                <span className="text-muted-foreground">社区数</span>
                <span className="font-mono text-success">{data.metadata.communities}</span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ============================================================
 * 🧩 AlgorithmPanel — 算法工具箱
 * ============================================================ */

interface PartitionBasisInput {
  gdsAlgorithm: 'louvain' | 'wcc' | 'original';
  clusteringStrategy: ClusteringStrategy | null;
  gdsRunInfo: GdsRunInfo | null;
  originalCommunities: number;
  clusteringResult: any | null;
}

function getPartitionBasisText(input: PartitionBasisInput): string {
  if (input.gdsAlgorithm !== 'original') {
    const algo = input.gdsAlgorithm.toUpperCase();
    const info = input.gdsRunInfo;
    if (info) {
      const source = info.source === 'neo4j' ? 'Neo4j GDS' : '本地算法';
      const fallback = info.fallback ? `，已降级（${info.fallbackReason}）` : '';
      const modularity = info.modularity != null ? `，模块度 ${info.modularity.toFixed(4)}` : '';
      const pz = info.physicalZoneZones != null ? `，PhysicalZone ${info.physicalZoneZones}` : '';
      return `${algo}（${source}）：基域 ${info.baseZones}${pz} + 属性细分${fallback}${modularity}`;
    }
    return `${algo} 动态分区`;
  }
  if (input.clusteringStrategy === 'zone_label' && input.clusteringResult) {
    return `Enrich zone_label 细分：${input.clusteringResult.zoneCount} 域`;
  }
  if (input.clusteringStrategy === 'security_v3' && input.clusteringResult) {
    const m = input.clusteringResult.metrics;
    const metricText = m ? `，模块度 ${m.modularity.toFixed(3)}，域内连接 ${m.intraEdgePct}%，平均 ${m.avgSize}，单节点域 ${m.singletons}` : '';
    return `三层安全域（核心基础设施 + 物理域 + 业务社区 + 属性细分）：${input.clusteringResult.zoneCount} 域${metricText}`;
  }
  return `数据原始分区：${input.originalCommunities} 域`;
}

interface AlgorithmPanelProps {
  data: TopologyData | null;
  originalCommunities: number;
  gdsRunInfo: GdsRunInfo | null;
  gdsAlgorithm: 'louvain' | 'wcc' | 'original';
  onSwitchAlgorithm: (algo: 'louvain' | 'wcc' | 'original') => void;
  gdsData: { nodes: any[]; zones: any[]; hubNodes: GDSHubNode[] } | null;
  runningGds: boolean;
  onRunGDS: (algorithm: 'louvain' | 'wcc') => void;
  onGDSAnalysisComplete?: () => void;
  clusteringStrategy: ClusteringStrategy | null;
  onSwitchClustering: (strategy: ClusteringStrategy | null) => void;
  clusteringResult: any | null;
  securityGranularity: SecurityV3Granularity;
  onSecurityGranularityChange: (granularity: SecurityV3Granularity) => void;
  securityEnrich: boolean;
  onSecurityEnrichChange: (enabled: boolean) => void;
}

export function AlgorithmPanel({
  data,
  originalCommunities,
  gdsRunInfo,
  gdsAlgorithm,
  onSwitchAlgorithm,
  gdsData,
  runningGds,
  onRunGDS,
  onGDSAnalysisComplete,
  clusteringStrategy,
  onSwitchClustering,
  clusteringResult,
  securityGranularity,
  onSecurityGranularityChange,
  securityEnrich,
  onSecurityEnrichChange,
}: AlgorithmPanelProps) {
  const enrichActive = clusteringStrategy === 'security_v3' ? securityEnrich : clusteringStrategy === 'zone_label';
  return (
    <div className="space-y-5">
      {/* 智能聚类 */}
      <div>
        <div className="flex items-center gap-1.5 mb-3">
          <Layers className="w-3.5 h-3.5 text-primary" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">智能聚类</span>
        </div>
        <button
          onClick={() => {
            if (clusteringStrategy === 'security_v3') {
              onSecurityEnrichChange?.(!securityEnrich);
            } else {
              onSwitchClustering?.('zone_label');
            }
          }}
          className={`w-full text-[11px] px-3 py-2.5 rounded-lg border transition-colors text-left flex items-center justify-between mt-2
            ${enrichActive
              ? 'bg-warning/15 border-warning/40 text-warning'
              : 'bg-secondary/40 border-border/60 text-foreground hover:border-primary/40'
            }`}
        >
          <span className="font-medium flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-warning" />
            Enrich 标签细分
          </span>
          {enrichActive && clusteringResult ? (
            <span className="text-[11px] bg-warning/15 text-warning px-1.5 py-0.5 rounded">{clusteringResult.zoneCount} 域</span>
          ) : (
            <span className="text-[11px] text-muted-foreground">{clusteringStrategy === 'security_v3' ? '叠加到三层安全域' : '使用 zone_label 细分'}</span>
          )}
        </button>
        <button
          onClick={() => onSwitchClustering?.('security_v3')}
          className={`w-full text-[11px] px-3 py-2.5 rounded-lg border transition-colors text-left flex items-center justify-between mt-2
            ${clusteringStrategy === 'security_v3'
              ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-500'
              : 'bg-secondary/40 border-border/60 text-foreground hover:border-emerald-500/40'
            }`}
        >
          <span className="font-medium flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            三层安全域
          </span>
          {clusteringStrategy === 'security_v3' && clusteringResult ? (
            <span className="text-[11px] bg-emerald-500/10 text-emerald-500 px-1.5 py-0.5 rounded">{clusteringResult.zoneCount} 域</span>
          ) : (
            <span className="text-[11px] text-muted-foreground">核心域 + 业务分层</span>
          )}
        </button>
        {clusteringStrategy === 'security_v3' && (
          <div className="mt-2">
            <div className="text-[10px] text-muted-foreground mb-1.5">粒度档位</div>
            <div className="grid grid-cols-3 gap-1.5">
              {(Object.keys(SECURITY_V3_GRANULARITY_LABELS) as SecurityV3Granularity[]).map(granularity => (
                <button
                  key={granularity}
                  onClick={() => onSecurityGranularityChange?.(granularity)}
                  className={`h-8 rounded-md border text-[11px] font-medium transition-colors ${
                    securityGranularity === granularity
                      ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-500'
                      : 'bg-secondary/30 border-border/50 text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {SECURITY_V3_GRANULARITY_LABELS[granularity]}
                </button>
              ))}
            </div>
          </div>
        )}
        {clusteringStrategy && clusteringResult && (
          <div className="text-[11px] text-muted-foreground/70 mt-1.5 leading-relaxed">
            使用 <span className="text-primary">{CLUSTERING_LABELS[clusteringStrategy as keyof typeof CLUSTERING_LABELS] || clusteringStrategy}</span> 策略进行智能分组，共 {clusteringResult.zoneCount} 个安全域。
          </div>
        )}
        {clusteringStrategy === 'security_v3' && clusteringResult?.metrics && (
          <div className="text-[11px] font-mono text-emerald-500/90 mt-1.5 leading-relaxed">
            {SECURITY_V3_GRANULARITY_LABELS[securityGranularity]}档 · 模块度 {clusteringResult.metrics.modularity.toFixed(3)} · 域内连接 {clusteringResult.metrics.intraEdgePct}% · 平均 {clusteringResult.metrics.avgSize} · 单节点域 {clusteringResult.metrics.singletons}{securityEnrich ? ' · 已叠加标签细分' : ''}
          </div>
        )}
      </div>

      <Separator />

      {/* 安全域划分模式 */}
      <div>
        <div className="flex items-center gap-1.5 mb-3">
          <Network className="w-3.5 h-3.5 text-violet-400" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">安全域划分模式</span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <button
            onClick={() => onSwitchAlgorithm('original')}
            disabled={runningGds}
            className={`px-2 py-3 rounded-lg text-[11px] font-medium transition-colors border text-center ${
              gdsAlgorithm === 'original'
                ? 'bg-primary/20 border-primary/50 text-primary'
                : 'bg-secondary/30 border-border/50 text-muted-foreground hover:border-border hover:text-foreground'
            } ${runningGds ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <svg className="w-4 h-4 mx-auto mb-1.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            原始分区
            {data && (
              <div className="text-[11px] mt-0.5 opacity-70">{originalCommunities} 域</div>
            )}
          </button>
          <button
            onClick={() => onSwitchAlgorithm('louvain')}
            disabled={runningGds}
            className={`px-2 py-3 rounded-lg text-[11px] font-medium transition-colors border text-center ${
              gdsAlgorithm === 'louvain'
                ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-400'
                : 'bg-secondary/30 border-border/50 text-muted-foreground hover:border-border hover:text-foreground'
            } ${runningGds ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {runningGds && gdsAlgorithm === 'louvain' ? (
              <svg className="w-4 h-4 mx-auto mb-1.5 animate-spin" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            ) : (
              <svg className="w-4 h-4 mx-auto mb-1.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            )}
            Louvain
            {gdsAlgorithm === 'louvain' && gdsData && (() => {
              const zones = gdsData.zones.filter((z: any) => z.algorithm === 'louvain');
              const ids = new Set(zones.map((z: any) => z.community));
              return <div className="text-[11px] mt-0.5 opacity-70">{ids.size} 域</div>;
            })()}
          </button>
          <button
            onClick={() => onSwitchAlgorithm('wcc')}
            disabled={runningGds}
            className={`px-2 py-3 rounded-lg text-[11px] font-medium transition-colors border text-center ${
              gdsAlgorithm === 'wcc'
                ? 'bg-purple-500/20 border-purple-500/50 text-purple-400'
                : 'bg-secondary/30 border-border/50 text-muted-foreground hover:border-border hover:text-foreground'
            } ${runningGds ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {runningGds && gdsAlgorithm === 'wcc' ? (
              <svg className="w-4 h-4 mx-auto mb-1.5 animate-spin" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            ) : (
              <svg className="w-4 h-4 mx-auto mb-1.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
            )}
            WCC
            {gdsAlgorithm === 'wcc' && gdsData && (() => {
              const zones = gdsData.zones.filter((z: any) => z.algorithm === 'wcc');
              const ids = new Set(zones.map((z: any) => z.community));
              return <div className="text-[11px] mt-0.5 opacity-70">{ids.size} 域</div>;
            })()}
          </button>
        </div>
        <div className="rounded-lg border border-border/40 bg-secondary/40 px-2.5 py-2 mt-2 text-[10px] leading-relaxed text-muted-foreground">
          <div className="flex items-center gap-1.5 mb-1 text-muted-foreground">
            <ShieldCheck className="w-3 h-3" />
            <span className="text-[11px] font-semibold uppercase tracking-wider">当前划分依据</span>
          </div>
          <div className="text-[10px] text-foreground/80">
            {getPartitionBasisText({ gdsAlgorithm, clusteringStrategy, gdsRunInfo, originalCommunities, clusteringResult })}
          </div>
        </div>
      </div>

      <Separator />

      {/* GDS 图算法面板 */}
      <div>
        <div className="flex items-center gap-1.5 mb-3">
          <svg className="w-3.5 h-3.5 text-violet-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">GDS 图算法</span>
        </div>
        <GDSPanel onAnalysisComplete={onGDSAnalysisComplete} />
      </div>
    </div>
  );
}

/* ============================================================
 * 🛡️ SecurityPanel — 安全策略
 * ============================================================ */

interface SecurityPanelProps {
  data: TopologyData | null;
  baselineRules: BaselineRule[];
  onBaselineRulesChange: (rules: BaselineRule[]) => void;
  whitelist: Array<{ id: string; nodeId: string; reason: string }>;
  onAddToWhitelist: (entry: { nodeId: string; reason: string }) => void;
  onRemoveFromWhitelist: (id: string) => void;
  onNodeSelect: (node: TopologyNode) => void;
}

export function SecurityPanel({
  data,
  baselineRules,
  onBaselineRulesChange,
  whitelist,
  onAddToWhitelist,
  onRemoveFromWhitelist,
  onNodeSelect,
}: SecurityPanelProps) {
  const [expandedSections, setExpandedSections] = useState({ baseline: true, whitelist: true });
  const [whitelistNodeId, setWhitelistNodeId] = useState('');
  const [whitelistReason, setWhitelistReason] = useState('');

  // Compute violations
  const violations = useMemo<BaselineViolation[]>(() => {
    if (!data) return [];
    const result: BaselineViolation[] = [];
    baselineRules.filter(r => r.enabled).forEach(rule => {
      data.nodes.forEach(node => {
        let value: number;
        switch (rule.field) {
          case 'anomaly_score': value = node.anomaly_score; break;
          case 'bytes_sent': value = node.bytes_sent; break;
          case 'bytes_received': value = node.bytes_received; break;
          case 'degree': value = node.degree; break;
          default: value = 0;
        }
        let violated = false;
        switch (rule.operator) {
          case 'gt': violated = value > rule.threshold; break;
          case 'lt': violated = value < rule.threshold; break;
          case 'eq': violated = value === rule.threshold; break;
          case 'between': violated = value >= rule.threshold && value <= (rule.thresholdMax ?? Infinity); break;
        }
        if (violated) {
          result.push({ rule, nodeId: node.id, actualValue: value });
        }
      });
    });
    return result;
  }, [data, baselineRules]);

  const toggleSection = (section: keyof typeof expandedSections) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const addToWhitelist = () => {
    if (!whitelistNodeId.trim()) return;
    onAddToWhitelist({
      nodeId: whitelistNodeId.trim(),
      reason: whitelistReason.trim() || '用户手动添加',
    });
    setWhitelistNodeId('');
    setWhitelistReason('');
  };

  return (
    <div className="space-y-4">
      {/* Baseline Rules */}
      <div>
        <button
          onClick={() => toggleSection('baseline')}
          className="flex items-center justify-between w-full mb-3"
        >
          <div className="flex items-center gap-1.5">
            <Shield className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-[11px] font-semibold text-foreground uppercase tracking-wider">安全基线规则</span>
          </div>
          <div className="flex items-center gap-1.5">
            {violations.length > 0 && (
              <Badge variant="destructive" className="text-[11px]">{violations.length}</Badge>
            )}
            {expandedSections.baseline ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
          </div>
        </button>
        {expandedSections.baseline && (
          <div className="space-y-2">
            {baselineRules.map(rule => (
              <BaselineRuleItem
                key={rule.id}
                rule={rule}
                violationCount={violations.filter(v => v.rule.id === rule.id).length}
                onToggle={() => {
                  const updated = baselineRules.map(r =>
                    r.id === rule.id ? { ...r, enabled: !r.enabled } : r
                  );
                  onBaselineRulesChange(updated);
                }}
              />
            ))}

            {violations.length > 0 && (
              <>
                <Separator className="my-3" />
                <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                  违规节点 ({violations.length})
                </div>
                <div className="space-y-1 max-h-[250px] overflow-y-auto">
                  {violations.slice(0, 20).map((v, i) => {
                    const node = data?.nodes.find(n => n.id === v.nodeId);
                    const fieldLabels: Record<string, string> = {
                      anomaly_score: '异常分数', bytes_sent: '发送字节',
                      bytes_received: '接收字节', degree: '连接数', port_entropy: '端口熵',
                    };
                    const operatorLabels: Record<string, string> = { gt: '>', lt: '<', eq: '=', between: '范围' };
                    const formatValue = (val: number, field: string) => {
                      if (field === 'bytes_sent' || field === 'bytes_received') {
                        if (val >= 1048576) return `${(val / 1048576).toFixed(1)}MB`;
                        if (val >= 1024) return `${(val / 1024).toFixed(1)}KB`;
                        return `${val}B`;
                      }
                      return val.toFixed(3);
                    };
                    return (
                      <div
                        key={`${v.nodeId}-${v.rule.id}-${i}`}
                        className="flex items-start gap-2 px-2.5 py-2 rounded-lg text-[11px] hover:bg-secondary/50 cursor-pointer border border-transparent hover:border-border/50 transition-colors"
                        onClick={() => { if (node) onNodeSelect(node); }}
                      >
                        <div
                          className="w-1.5 h-1.5 rounded-full shrink-0 mt-1"
                          style={{ backgroundColor: ANOMALY_LEVEL_COLORS[v.rule.severity === 'critical' ? 'Critical' : v.rule.severity === 'high' ? 'High' : v.rule.severity === 'medium' ? 'Medium' : 'Low'] }}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-[10px] truncate">{v.nodeId}</span>
                            <span className="text-muted-foreground text-[11px]">
                              {fieldLabels[v.rule.field]} {operatorLabels[v.rule.operator]} {v.rule.threshold}
                            </span>
                          </div>
                          <div className="text-[11px] text-muted-foreground mt-0.5">
                            实际值: {formatValue(v.actualValue, v.rule.field)}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {violations.length > 20 && (
                    <div className="text-[10px] text-muted-foreground text-center py-1">
                      +{violations.length - 20} 更多...
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <Separator />

      {/* Whitelist */}
      <div>
        <button
          onClick={() => toggleSection('whitelist')}
          className="flex items-center justify-between w-full mb-3"
        >
          <div className="flex items-center gap-1.5">
            <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-[11px] font-semibold text-foreground uppercase tracking-wider">白名单</span>
            {whitelist.length > 0 && (
              <span className="text-[11px] text-emerald-400/70">({whitelist.length})</span>
            )}
          </div>
          <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform duration-200 ${!expandedSections.whitelist ? '-rotate-90' : ''}`} />
        </button>
        {expandedSections.whitelist && (
          <div className="space-y-2">
            <div className="flex gap-1.5">
              <Input
                aria-label="白名单 IP 地址"
                name="whitelist-ip"
                autoComplete="off"
                placeholder="IP 地址"
                className="h-8 text-[11px] font-mono flex-1"
                value={whitelistNodeId}
                onChange={(e) => setWhitelistNodeId(e.target.value)}
              />
              <Button size="sm" className="h-8 px-3 text-[11px]" onClick={addToWhitelist}>
                <Plus className="w-3 h-3 mr-1" />
                添加
              </Button>
            </div>
            <Input
              aria-label="白名单原因"
              name="whitelist-reason"
              autoComplete="off"
              placeholder="原因 (可选)"
              className="h-7 text-[10px]"
              value={whitelistReason}
              onChange={(e) => setWhitelistReason(e.target.value)}
            />
            {whitelist.length > 0 && (
              <div className="space-y-1 max-h-[200px] overflow-y-auto mt-2">
                {whitelist.map(w => (
                  <div key={w.id} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-secondary/20 text-[10px] border border-border/30">
                    <CheckCircle className="w-3 h-3 text-emerald-400/70 shrink-0" />
                    <span className="font-mono truncate flex-1">{w.nodeId}</span>
                    <span className="text-muted-foreground text-[11px] shrink-0">{w.reason}</span>
                    <button onClick={() => onRemoveFromWhitelist(w.id)} className="text-destructive hover:text-destructive/80 shrink-0">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
 * 📊 StatsPanel — 统计面板
 * ============================================================ */

interface StatsPanelProps {
  data: TopologyData | null;
  onSearchNode: (query: string) => void;
  onHighlightCommunity: (id: number | null) => void;
  focusedCommunity: number | null;
  onToggleFocus: (communityId: number | null) => void;
  gdsAlgorithm: 'louvain' | 'wcc' | 'original';
  gdsRunInfo: GdsRunInfo | null;
  clusteringStrategy: ClusteringStrategy | null;
  clusteringResult: any | null;
  originalCommunities: number;
  hubNodes: GDSHubNode[];
  onQueryPath?: (source: string, target: string) => void;
  onClearPath?: () => void;
  pathNodeIds: string[];
  onExpandNeighbors?: (nodeId: string, hops: number) => void;
  onClearExpansion?: () => void;
  expansionNodeCount: number;
  selectedNode: TopologyNode | null;
}

export function StatsPanel({
  data,
  onSearchNode,
  onHighlightCommunity,
  focusedCommunity,
  onToggleFocus,
  gdsAlgorithm,
  gdsRunInfo,
  clusteringStrategy,
  clusteringResult,
  originalCommunities,
  hubNodes = [],
  onQueryPath,
  onClearPath,
  pathNodeIds = [],
  onExpandNeighbors,
  onClearExpansion,
  expansionNodeCount = 0,
  selectedNode,
}: StatsPanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedSections, setExpandedSections] = useState({
    domains: true,
    path: false,
    expansion: false,
  });

  // Stats
  const stats = useMemo<NetworkStats>(() => {
    if (!data) {
      return {
        totalNodes: 0, totalLinks: 0, totalCommunities: 0, anomalyCount: 0,
        criticalCount: 0, highCount: 0, mediumCount: 0, totalTraffic: 0, avgDegree: 0, maxDegree: 0,
      };
    }
    const anomalyNodes = data.nodes.filter(n => n.is_anomaly);
    const degrees = data.nodes.map(n => n.degree || 0);
    return {
      totalNodes: data.nodes.length,
      totalLinks: data.links.length,
      totalCommunities: data.metadata.communities,
      anomalyCount: anomalyNodes.length,
      criticalCount: anomalyNodes.filter(n => n.anomaly_level === 'Critical').length,
      highCount: anomalyNodes.filter(n => n.anomaly_level === 'High').length,
      mediumCount: anomalyNodes.filter(n => n.anomaly_level === 'Medium').length,
      totalTraffic: data.nodes.reduce((sum, n) => sum + (n.bytes_sent || 0) + (n.bytes_received || 0), 0),
      avgDegree: degrees.length > 0 ? Math.round(degrees.reduce((a, b) => a + b, 0) / degrees.length) : 0,
      maxDegree: Math.max(...degrees, 0),
    };
  }, [data]);

  // Domains
  const domains = useMemo<SecurityDomain[]>(() => {
    if (!data) return [];
    const communityMap = new Map<number, TopologyNode[]>();
    data.nodes.forEach(n => {
      if (!communityMap.has(n.community)) communityMap.set(n.community, []);
      communityMap.get(n.community)!.push(n);
    });
    const nodeById = new Map(data.nodes.map(n => [n.id, n]));
    const linkCounts = new Map<number, number>();
    data.links.forEach(l => {
      const srcId = typeof l.source === 'string' ? l.source : l.source.id;
      const tgtId = typeof l.target === 'string' ? l.target : l.target.id;
      const srcCommunity = nodeById.get(srcId)?.community;
      const tgtCommunity = nodeById.get(tgtId)?.community;
      if (srcCommunity != null) linkCounts.set(srcCommunity, (linkCounts.get(srcCommunity) || 0) + 1);
      if (tgtCommunity != null && tgtCommunity !== srcCommunity) {
        linkCounts.set(tgtCommunity, (linkCounts.get(tgtCommunity) || 0) + 1);
      }
    });
    return Array.from(communityMap.entries())
      .map(([id, nodes]) => ({
        id,
        name: (() => {
          if (gdsAlgorithm === 'louvain') return getGDSDomainName('louvain', id, nodes);
          if (gdsAlgorithm === 'wcc') return getGDSDomainName('wcc', id, nodes);
          const zoneName = data.domainNames?.[id];
          if (zoneName && zoneName !== 'Unassigned' && !zoneName.match(/^(zone[_-]?\d+|Zone\s*\d+)$/i)) {
            return zoneName;
          }
          return getDomainName(id, nodes);
        })(),
        description: getDomainDescription(nodes),
        color: COMMUNITY_COLORS[id % COMMUNITY_COLORS.length],
        nodeCount: nodes.length,
        linkCount: linkCounts.get(id) || 0,
        avgAnomalyScore: nodes.reduce((s, n) => s + n.anomaly_score, 0) / nodes.length,
        totalBytes: nodes.reduce((s, n) => s + (n.bytes_sent || 0) + (n.bytes_received || 0), 0),
      }))
      .sort((a, b) => b.nodeCount - a.nodeCount);
  }, [data, gdsAlgorithm]);

  const zoneOverlapPct = useMemo(() => {
    if (!data || !clusteringResult?.zones?.length) return null;
    const derived = new Map<string, string>();
    clusteringResult.zones.forEach((z: { node_id: string; zone_id: string }) => derived.set(z.node_id, z.zone_id));
    const groups = new Map<string, string[]>();
    data.nodes.forEach(n => {
      const label = n.zone_label || n.zone_id;
      if (!label || label === 'Unassigned' || label === 'default') return;
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label)!.push(n.id);
    });
    if (groups.size === 0) return null;
    let weighted = 0;
    let total = 0;
    for (const members of groups.values()) {
      if (members.length === 0) continue;
      const counts = new Map<string, number>();
      members.forEach(id => {
        const zid = derived.get(id);
        if (zid) counts.set(zid, (counts.get(zid) || 0) + 1);
      });
      const majority = Math.max(...counts.values(), 0) / members.length;
      weighted += majority * members.length;
      total += members.length;
    }
    return total > 0 ? Math.round((weighted / total) * 100) : null;
  }, [data, clusteringResult]);

  const toggleSection = (section: keyof typeof expandedSections) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const handleSearch = () => {
    if (searchQuery.trim()) {
      onSearchNode(searchQuery.trim());
    }
  };

  return (
    <div className="space-y-4">
      {/* Search */}
      <div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            aria-label="搜索 IP 地址"
            name="stats-search"
            autoComplete="off"
            placeholder="搜索 IP 地址..."
            className="pl-8 h-8 text-xs font-mono bg-muted/50 border-border/70 focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/30 backdrop-blur-sm placeholder:text-muted-foreground/70"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
          />
        </div>
      </div>

      {/* Network Overview */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5 text-primary" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">网络总览</span>
          </div>
          {data && (
            <span className="text-[11px] font-mono text-muted-foreground">{stats.totalNodes}N / {stats.totalLinks}L</span>
          )}
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          <div className="stat-card relative overflow-hidden rounded-md px-2 py-1.5" style={{ background: 'color-mix(in srgb, var(--muted) 60%, transparent)', border: '1px solid var(--border)' }}>
            <div className="absolute top-0 left-0 right-0 h-px" style={{ background: 'linear-gradient(90deg, transparent, var(--primary), transparent)' }} />
            <div className="text-[11px] text-muted-foreground">节点</div>
            <div className="text-xs font-semibold font-mono text-primary">{stats.totalNodes}</div>
          </div>
          <div className="stat-card relative overflow-hidden rounded-md px-2 py-1.5" style={{ background: 'color-mix(in srgb, var(--muted) 60%, transparent)', border: '1px solid var(--border)' }}>
            <div className="absolute top-0 left-0 right-0 h-px" style={{ background: 'linear-gradient(90deg, transparent, var(--primary), transparent)' }} />
            <div className="text-[11px] text-muted-foreground">连接</div>
            <div className="text-xs font-semibold font-mono text-primary">{stats.totalLinks}</div>
          </div>
          <div className="stat-card relative overflow-hidden rounded-md px-2 py-1.5" style={{ background: 'color-mix(in srgb, var(--muted) 60%, transparent)', border: '1px solid var(--border)' }}>
            <div className="absolute top-0 left-0 right-0 h-px" style={{ background: 'linear-gradient(90deg, transparent, var(--success), transparent)' }} />
            <div className="text-[11px] text-muted-foreground">安全域</div>
            <div className="text-xs font-semibold font-mono text-success">{stats.totalCommunities}</div>
          </div>
        </div>
        {(stats.anomalyCount > 0 || stats.avgDegree > 0) && (
          <div className="flex items-center gap-3 mt-1.5 px-1">
            {stats.anomalyCount > 0 && (
              <span className="text-[11px] text-destructive flex items-center gap-1">
                <AlertTriangle className="w-2.5 h-2.5" /> {stats.anomalyCount} 异常
              </span>
            )}
            <span className="text-[11px] text-muted-foreground">平均度 {stats.avgDegree}</span>
            <span className="text-[11px] text-muted-foreground">流量 {formatBytes(stats.totalTraffic)}</span>
          </div>
        )}
        {clusteringStrategy === 'security_v3' && clusteringResult?.metrics && (
          <div className="mt-1.5 mx-1 rounded-md p-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5" style={{ background: 'color-mix(in srgb, var(--muted) 60%, transparent)', border: '1px solid color-mix(in srgb, var(--success) 25%, var(--border))' }}>
            <div className="col-span-2 text-[10px] font-semibold uppercase tracking-wider text-emerald-500/90 flex items-center gap-1">
              <ShieldCheck className="w-3 h-3" />
              三层安全域可信度
            </div>
            <div className="text-[11px] text-muted-foreground">模块度 <span className="text-foreground font-mono float-right">{clusteringResult.metrics.modularity.toFixed(3)}</span></div>
            <div className="text-[11px] text-muted-foreground">域内连接 <span className="text-foreground font-mono float-right">{clusteringResult.metrics.intraEdgePct}%</span></div>
            <div className="text-[11px] text-muted-foreground">平均规模 <span className="text-foreground font-mono float-right">{clusteringResult.metrics.avgSize}</span></div>
            <div className="text-[11px] text-muted-foreground">单节点域 <span className="text-foreground font-mono float-right">{clusteringResult.metrics.singletons}</span></div>
            {zoneOverlapPct != null && (
              <div className="col-span-2 text-[11px] text-muted-foreground">与 zone_id 重合度 <span className="text-foreground font-mono float-right">{zoneOverlapPct}%</span></div>
            )}
          </div>
        )}
      </div>

      <Separator />

      {/* Security Domains / Hub Nodes Tabs */}
      <div>
        <Tabs defaultValue="domains" className="w-full">
          <TabsList className="w-full h-7 bg-secondary/30 p-[2px] mb-2">
            <TabsTrigger value="domains" className="flex-1 h-6 text-[11px] gap-1 data-[state=active]:bg-primary/15 data-[state=active]:text-primary">
              <Tags className="w-3 h-3" />
              安全域
            </TabsTrigger>
            <TabsTrigger value="hubnodes" className="flex-1 h-6 text-[11px] gap-1 data-[state=active]:bg-orange-400/15 data-[state=active]:text-warning">
              <TrendingUp className="w-3 h-3" />
              关键节点
            </TabsTrigger>
          </TabsList>

          <TabsContent value="domains" className="mt-0">
            <VirtualizedDomainList
              domains={domains}
              data={data}
              focusedCommunity={focusedCommunity}
              onToggleFocus={onToggleFocus}
              onHighlightCommunity={onHighlightCommunity}
            />
          </TabsContent>

          <TabsContent value="hubnodes" className="mt-0">
            {hubNodes.length > 0 && gdsAlgorithm !== 'original' ? (
              <div className="space-y-1 max-h-[35vh] overflow-y-auto pr-1 scrollbar-thin [content-visibility:auto]">
                <div className="text-[10px] text-warning/70 font-medium uppercase tracking-wider mb-1.5">
                  PageRank Top {Math.min(hubNodes.length, 5)}
                </div>
                {hubNodes.slice(0, 5).map((hub, i) => (
                  <div
                    key={hub.ip}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-secondary/20 border border-border/30 hover:border-orange-400/30 transition-colors cursor-pointer"
                    onClick={() => onSearchNode(hub.ip)}
                  >
                    <span className="text-[11px] font-mono text-warning w-4 text-right">{i + 1}.</span>
                    <div className="w-2 h-2 rounded-full bg-orange-400/70 shrink-0" />
                    <span className="text-[11px] font-mono text-foreground truncate flex-1">{hub.ip}</span>
                    <Badge className="text-[11px] h-4 bg-orange-400/10 text-orange-300 border-orange-400/20">
                      {hub.score.toFixed(4)}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[10px] text-muted-foreground text-center py-4 border border-dashed border-border/50 rounded-md">
                {gdsAlgorithm === 'original'
                  ? '请先在"算法工具箱"中运行 GDS 算法'
                  : '暂无枢纽节点数据'}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>

      <Separator />

      {/* Path Query */}
      <div>
        <div className="flex items-center justify-between w-full mb-2">
          <button type="button" onClick={() => toggleSection('path')} className="flex items-center gap-1.5 cursor-pointer select-none">
            <Route className="w-3.5 h-3.5 text-cyan-400" />
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">最短路径</span>
            <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform duration-200 ${!expandedSections.path ? '-rotate-90' : ''}`} />
          </button>
          {pathNodeIds && pathNodeIds.length > 0 && (
            <button type="button" onClick={onClearPath} className="text-[11px] text-muted-foreground hover:text-foreground">清除</button>
          )}
        </div>
        {expandedSections.path && (
          <PathQueryForm onQuery={onQueryPath} hasResult={pathNodeIds && pathNodeIds.length > 0} pathLength={pathNodeIds?.length || 0} />
        )}
      </div>

      {/* N-hop Expansion */}
      <div>
        <div className="flex items-center justify-between w-full mb-2">
          <button type="button" onClick={() => toggleSection('expansion')} className="flex items-center gap-1.5 cursor-pointer select-none">
            <Expand className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">N跳扩展</span>
            <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform duration-200 ${!expandedSections.expansion ? '-rotate-90' : ''}`} />
          </button>
          {expansionNodeCount > 0 && (
            <button type="button" onClick={onClearExpansion} className="text-[11px] text-muted-foreground hover:text-foreground">清除</button>
          )}
        </div>
        {expandedSections.expansion && (
          <>
          <div className="text-[10px] text-muted-foreground">双击图中节点，可快速展开其 1 跳邻居</div>
          <NeighborExpansion
            selectedNodeId={selectedNode?.id || null}
            onExpand={onExpandNeighbors}
            expansionNodeCount={expansionNodeCount || 0}
          />
          </>
        )}
      </div>
    </div>
  );
}
