// src/components/enrich-panel.tsx
// Enricher 手动触发面板 - 用于 sidebar 中展示
'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Zap, Play, Loader2, CheckCircle, XCircle, AlertCircle,
  RefreshCw, ChevronDown, ChevronRight,
} from 'lucide-react';
import type { TopologyNode } from '@/lib/types';

// ---- 字段名 → 中文标签映射 ----
const FIELD_LABELS: Record<string, string> = {
  // 地理位置
  geo_country: '国家',
  geo_city: '城市',
  geo_isp: '运营商',
  geo_org: '组织',
  geo_latitude: '纬度',
  geo_longitude: '经度',
  // 网络
  subnet_24: 'C 类网段',
  subnet_cidr: '子网',
  subnet_class: '子网类型',
  // 服务
  service_type: '服务类型',
  service_confidence: '置信度',
  // 异常
  anomaly_score: '异常分数',
  anomaly_level: '异常等级',
  // 基础
  degree: '连接数',
  in_degree: '入度',
  out_degree: '出度',
  bytes_sent: '发送流量',
  bytes_received: '接收流量',
  is_hub: '是否 Hub',
  is_anomaly: '是否异常',
  role_guess: '角色',
  open_port_count: '开放端口数',
  ports: '端口',
  protocols: '协议',
  class_a: 'A 段',
  class_b: 'B 段',
  class_c: 'C 段',
  ip_count: 'IP 数量',
  is_private: '私有网段',
  anomaly_score_enriched: '归一化异常分',
};

// 不应显示的内部字段
const INTERNAL_FIELDS = new Set(['primary', 'community', 'enricher_chain', 'id', 'type']);

const CATEGORY_LABELS: Record<string, string> = {
  Geo: '位置',
  Network: '网段',
  Service: '服务',
  Risk: '风险',
};

const ENRICHER_LABELS: Record<string, string> = {
  subnet_cidr: '网段识别',
  service_type: '服务大类',
  port_service: '端口服务',
  anomaly_score: '异常评分',
};

const PROPERTY_GROUPS: Array<{ id: string; label: string; fields: string[] }> = [
  { id: 'geo', label: '位置', fields: ['geo_country', 'geo_city', 'geo_isp', 'geo_org', 'geo_latitude', 'geo_longitude'] },
  { id: 'network', label: '网段', fields: ['subnet_24', 'subnet_cidr', 'subnet_class', 'class_a', 'class_b', 'class_c', 'ip_count', 'is_private'] },
  { id: 'service', label: '服务', fields: ['service_type', 'service_confidence', 'open_port_count', 'ports', 'protocols'] },
  { id: 'risk', label: '风险', fields: ['anomaly_score', 'anomaly_level', 'anomaly_score_enriched', 'is_anomaly'] },
  { id: 'graph', label: '图属性', fields: ['degree', 'in_degree', 'out_degree', 'bytes_sent', 'bytes_received', 'is_hub', 'role_guess'] },
];

function groupProperties(properties: Record<string, unknown>) {
  const entries = Object.entries(properties).filter(([key]) => !INTERNAL_FIELDS.has(key));
  const grouped: Record<string, Array<[string, unknown]>> = {};
  for (const [key, value] of entries) {
    const groupId = PROPERTY_GROUPS.find(group => group.fields.includes(key))?.id ?? 'other';
    (grouped[groupId] ||= []).push([key, value]);
  }
  const ordered = PROPERTY_GROUPS.filter(group => grouped[group.id]).map(group => ({
    id: group.id,
    label: group.label,
    items: grouped[group.id],
  }));
  if (grouped.other) ordered.push({ id: 'other', label: '其他', items: grouped.other });
  return ordered;
}

// ---- Types ----
interface EnricherInfo {
  name: string;
  category: string;
  applicable_type: string;
  enabled: boolean;
  description: string;
}

interface EnricherStats {
  [name: string]: {
    scanned: number;
    succeeded: number;
    errors: number;
    duration_ms: number;
  };
}

interface ServiceInfo {
  id: string;
  name: string;
  port: number;
  protocol: string;
  confidence: number;
}

interface EnrichResult {
  ip: string;
  enriched: boolean;
  error?: string;
  properties?: Record<string, unknown>;
  enricher_chain?: string[];
  new_services?: ServiceInfo[];
  new_relationships?: Array<{
    source: string;
    type: string;
    target: string;
    target_type: string;
    props?: Record<string, unknown>;
  }>;
  enricher_stats?: EnricherStats;
  errors?: string[];
}

interface EnrichPanelProps {
  /** 当前选中的节点 IP（null 表示没有选中） */
  selectedNodeId: string | null;
  /** 选中节点实体，用于把端口/度数等已有属性带回单点 enrich */
  selectedNode?: TopologyNode | null;
  /** enrich 完成后回调，用于更新图数据 */
  onEnrichComplete?: (ip: string, result: EnrichResult) => void;
}

// ---- 主组件 ----
export function EnrichPanel({ selectedNodeId, selectedNode, onEnrichComplete }: EnrichPanelProps) {
  const [enrichers, setEnrichers] = useState<EnricherInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingList, setLoadingList] = useState(true);
  const [result, setResult] = useState<EnrichResult | null>(null);
  const [selectedEnricher, setSelectedEnricher] = useState<string | null>(null);
  const [showAllResults, setShowAllResults] = useState(true);  // default expanded for debugging
  const [collapsedPropertyGroups, setCollapsedPropertyGroups] = useState<Record<string, boolean>>({
    geo: true,
    risk: true,
  });

  // 加载可用 enricher 列表
  useEffect(() => {
    fetchEnricherList();
  }, []);

  const fetchEnricherList = async () => {
    setLoadingList(true);
    try {
      const res = await fetch('/api/enrich');
      const data = await res.json();
      if (data.enrichers) {
        const visible = (data.enrichers as EnricherInfo[]).filter(e => e.enabled);
        setEnrichers(visible);
        setSelectedEnricher(prev => prev && visible.some(e => e.name === prev) ? prev : null);
      }
    } catch (err) {
      console.error('Failed to load enrichers:', err);
    } finally {
      setLoadingList(false);
    }
  };

  // 执行 enrich
  const runEnrich = useCallback(async (enricherName?: string) => {
    if (!selectedNodeId) return;
    setLoading(true);
    setResult(null);

    const nodePayload = selectedNode ? {
      degree: selectedNode.degree,
      in_degree: selectedNode.in_degree,
      out_degree: selectedNode.out_degree,
      ports: selectedNode.ports ?? [],
      protocols: selectedNode.protocols ?? [],
      is_hub: selectedNode.is_hub ?? false,
      subnet_24: selectedNode.subnet_24,
      service_type: selectedNode.service_type,
      service_confidence: selectedNode.service_confidence,
    } : undefined;

    try {
      const res = await fetch('/api/enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: selectedNodeId,
          enricher: enricherName || undefined,
          node: nodePayload,
        }),
      });

      const data: EnrichResult = await res.json();
      setResult(data);

      // 通知父组件更新
      if (data.enriched && onEnrichComplete) {
        onEnrichComplete(selectedNodeId, data);
      }
    } catch (err) {
      setResult({
        ip: selectedNodeId,
        enriched: false,
        error: err instanceof Error ? err.message : '请求失败',
      });
    } finally {
      setLoading(false);
    }
  }, [selectedNodeId, selectedNode, onEnrichComplete]);

  const togglePropertyGroup = (id: string) => {
    setCollapsedPropertyGroups(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const enabledEnrichers = enrichers.filter(e => e.enabled && e.applicable_type === 'IP');

  return (
    <div className="space-y-3">
      {/* 标题 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-amber-400" />
          <span className="text-xs font-semibold text-foreground">Enricher 执行</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          onClick={fetchEnricherList}
          disabled={loadingList}
        >
          <RefreshCw className={`w-3 h-3 ${loadingList ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* 目标 IP 显示 */}
      {selectedNodeId && (
        <div className="rounded-md bg-primary/10 border border-primary/20 px-3 py-2">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">目标节点</div>
          <div className="text-xs font-mono font-medium text-primary">{selectedNodeId}</div>
        </div>
      )}

      {!selectedNodeId && (
        <div className="text-xs text-muted-foreground text-center py-4 border border-dashed border-border/50 rounded-md">
          选中一个节点后，可对其执行 Enricher
        </div>
      )}

      {/* 操作按钮 */}
      {selectedNodeId && (
        <div className="flex gap-2">
          <Button
            size="sm"
            className="flex-1 text-xs"
            onClick={() => runEnrich()}
            disabled={loading}
          >
            {loading ? (
              <>
                <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                执行中...
              </>
            ) : (
              <>
                <Play className="w-3 h-3 mr-1" />
                运行全部
              </>
            )}
          </Button>
        </div>
      )}

      {/* 单独执行 */}
      {selectedNodeId && enabledEnrichers.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex gap-2 items-center">
            <select
              value={selectedEnricher ?? ''}
              onChange={(e) => setSelectedEnricher(e.target.value || null)}
              className="h-8 min-w-0 flex-1 rounded-md border border-border/70 bg-background px-2 text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">单独执行...</option>
              {enabledEnrichers.map(enricher => (
                <option key={enricher.name} value={enricher.name}>
                  {CATEGORY_LABELS[enricher.category] || enricher.category} / {ENRICHER_LABELS[enricher.name] || enricher.name}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              className="h-8 w-8 p-0 shrink-0"
              disabled={!selectedEnricher || loading}
              onClick={() => selectedEnricher && runEnrich(selectedEnricher)}
              title="执行所选"
            >
              {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
            </Button>
          </div>
          {selectedEnricher && (
            <div className="text-[11px] text-muted-foreground leading-snug">
              {enabledEnrichers.find(e => e.name === selectedEnricher)?.description}
            </div>
          )}
        </div>
      )}


      {/* 执行结果 */}
      {result && (
        <>
          <Separator />
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                执行结果
              </span>
              {result.enriched ? (
                <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-[11px]">
                  <CheckCircle className="w-2.5 h-2.5 mr-0.5" />
                  成功
                </Badge>
              ) : (
                <Badge className="bg-red-500/20 text-red-400 border-red-500/30 text-[11px]">
                  <XCircle className="w-2.5 h-2.5 mr-0.5" />
                  失败
                </Badge>
              )}
            </div>

            {/* 错误信息 */}
            {result.error && (
              <div className="flex items-start gap-1.5 px-2 py-1.5 rounded-md bg-red-500/10 border border-red-500/20">
                <AlertCircle className="w-3 h-3 text-red-400 shrink-0 mt-0.5" />
                <span className="text-[10px] text-red-300">{result.error}</span>
              </div>
            )}

            {/* 属性更新（按类别分组，默认收起低频字段） */}
            {result.enriched && result.properties && Object.keys(result.properties).length > 0 && (
              <div className="rounded-md bg-secondary/30 border border-border/50 p-2">
                <div className="text-[10px] font-medium text-muted-foreground mb-1">属性更新</div>
                <div className="space-y-1.5 max-h-[150px] overflow-y-auto scrollbar-thin">
                  {groupProperties(result.properties).map(group => (
                    <div key={group.id}>
                      <button
                        onClick={() => togglePropertyGroup(group.id)}
                        className="flex w-full items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {collapsedPropertyGroups[group.id] ? (
                          <ChevronRight className="w-2.5 h-2.5 shrink-0" />
                        ) : (
                          <ChevronDown className="w-2.5 h-2.5 shrink-0" />
                        )}
                        {group.label}
                        <span className="text-[8px] text-muted-foreground/60">{group.items.length}</span>
                      </button>
                      {!collapsedPropertyGroups[group.id] && (
                        <div className="space-y-0.5 ml-3">
                          {group.items.map(([key, value]) => {
                            const label = FIELD_LABELS[key] || key;
                            return (
                              <div key={key} className="flex items-center justify-between text-[10px]">
                                <span className="text-muted-foreground">{label}</span>
                                <span className="font-mono text-foreground truncate max-w-[150px]" title={typeof value === 'object' ? JSON.stringify(value) : String(value)}>
                                  {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 新发现的服务 */}
            {result.new_services && result.new_services.length > 0 && (
              <div className="rounded-md bg-secondary/30 border border-border/50 p-2">
                <div className="text-[10px] font-medium text-muted-foreground mb-1">
                  发现服务 ({result.new_services.length})
                </div>
                <div className="space-y-0.5">
                  {result.new_services.map(svc => (
                    <div key={svc.id} className="flex items-center justify-between text-[10px]">
                      <span className="font-medium">{svc.name}</span>
                      <span className="font-mono text-muted-foreground">
                        {svc.port}/{svc.protocol}{svc.confidence != null ? ` (${(svc.confidence * 100).toFixed(0)}%)` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Enricher 链 */}
            {result.enricher_chain && result.enricher_chain.length > 0 && (
              <div className="flex items-center gap-1 flex-wrap">
                <span className="text-[11px] text-muted-foreground">经过:</span>
                {result.enricher_chain.map(name => (
                  <Badge key={name} variant="outline" className="text-[8px] px-1 py-0">
                    {name}
                  </Badge>
                ))}
              </div>
            )}

            {/* Enricher 统计 - 只显示有实际执行的 */}
            {result.enricher_stats && (
              <div className="rounded-md bg-secondary/30 border border-border/50 p-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-medium text-muted-foreground">执行链</span>
                  <button
                    onClick={() => setShowAllResults(!showAllResults)}
                    className="text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    {showAllResults ? '收起' : '展开'}
                  </button>
                </div>
                <div className="space-y-0.5">
                  {Object.entries(result.enricher_stats)
                    .filter(([name, stats]) => showAllResults || stats.succeeded > 0 || stats.errors > 0)
                    .map(([name, stats]) => (
                      <div key={name} className="flex items-center justify-between text-[11px]">
                        <span className="font-mono truncate max-w-[120px]">{name}</span>
                        <div className="flex items-center gap-2">
                          {stats.succeeded > 0 ? (
                            <span className="text-emerald-400">✓ {stats.succeeded}</span>
                          ) : (
                            <span className="text-muted-foreground/50">跳过</span>
                          )}
                          {stats.errors > 0 && <span className="text-red-400">✗ {stats.errors}</span>}
                          <span className="text-muted-foreground/60">{stats.duration_ms}ms</span>
                        </div>
                      </div>
                    ))}
                  {!showAllResults && Object.entries(result.enricher_stats).filter(([, s]) => s.succeeded === 0 && s.errors === 0).length > 0 && (
                    <div className="text-[8px] text-muted-foreground/50 mt-0.5">
                      {Object.entries(result.enricher_stats).filter(([, s]) => s.succeeded === 0 && s.errors === 0).length} 个 enricher 被跳过
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
