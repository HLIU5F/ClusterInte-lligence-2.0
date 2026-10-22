'use client';

// src/components/reachability-panel.tsx
// 横向可达性分析 —— 回答「这台机器一旦被拿下，下一步能摸到哪些高价值资产」。
//
// 优先走服务端 /api/analysis/reachable（Neo4j 全量图上的有界 BFS，跨域可达也准确）；
// 库里连不上时回退到浏览器本地 BFS（只用已加载的边，结果会受限，界面会标注）。

import { useState, useEffect, useCallback, useMemo } from 'react';
import type { TopologyData, TopologyNode } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ROLE_LABELS } from '@/lib/types';
import { Radar, Loader2, AlertCircle, ArrowRight, Crosshair, ShieldAlert } from 'lucide-react';

interface ReachTarget {
  id: string;
  hops: number;
  assetValue: number;
  zoneId: string | null;
  zoneLabel: string | null;
  role: string | null;
  degree: number;
  isCrossDomain: boolean;
}

interface ReachResult {
  success: boolean;
  error?: string;
  sourceZone?: string | null;
  reached?: number;
  byHop?: Array<{ hops: number; nodes: number }>;
  highValueReached?: number;
  targets?: ReachTarget[];
  /** 'neo4j' = 服务端全量图；'local' = 浏览器本地回退 */
  computedBy?: 'neo4j' | 'local';
}

interface ReachabilityPanelProps {
  selectedNodeId: string | null;
  selectedNode?: TopologyNode | null;
  data: TopologyData | null;
  onNodeSelect?: (node: TopologyNode) => void;
}

/** 本地回退：在已加载的边上做 BFS（结果受限于画布数据） */
function computeLocally(
  data: TopologyData,
  source: string,
  maxHops: number,
  topN: number,
  minAssetValue: number
): ReachResult {
  const nodeById = new Map(data.nodes.map(n => [n.id, n]));
  const adj = new Map<string, string[]>();
  for (const l of data.links) {
    const s = typeof l.source === 'string' ? l.source : (l.source as { id: string }).id;
    const t = typeof l.target === 'string' ? l.target : (l.target as { id: string }).id;
    if (!adj.has(s)) adj.set(s, []);
    if (!adj.has(t)) adj.set(t, []);
    adj.get(s)!.push(t);
    adj.get(t)!.push(s);
  }

  const hops = new Map<string, number>([[source, 0]]);
  let frontier = [source];
  const byHop: Array<{ hops: number; nodes: number }> = [];
  for (let h = 1; h <= maxHops; h++) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const nb of adj.get(cur) ?? []) {
        if (hops.has(nb)) continue;
        hops.set(nb, h);
        next.push(nb);
      }
    }
    if (next.length === 0) break;
    byHop.push({ hops: h, nodes: next.length });
    frontier = next;
  }

  const srcZone = nodeById.get(source)?.zone_id ?? null;
  const reachedNodes = [...hops.entries()].filter(([id]) => id !== source);
  const targets: ReachTarget[] = reachedNodes
    .map(([id, h]) => {
      const n = nodeById.get(id);
      return {
        id,
        hops: h,
        assetValue: 0,
        zoneId: n?.zone_id ?? null,
        zoneLabel: n?.zone_label ?? null,
        role: n?.role_guess ?? null,
        degree: n?.degree ?? 0,
        isCrossDomain: srcZone != null && (n?.zone_id ?? null) !== srcZone,
      };
    })
    .sort((a, b) => b.degree - a.degree)
    .slice(0, topN);

  return {
    success: true,
    sourceZone: srcZone,
    reached: reachedNodes.length,
    byHop,
    highValueReached: reachedNodes.length, // 本地无 asset_value，全部计入
    targets,
    computedBy: 'local',
  };
}

export function ReachabilityPanel({ selectedNodeId, selectedNode, data, onNodeSelect }: ReachabilityPanelProps) {
  const [maxHops, setMaxHops] = useState(2);
  const [minAssetValue, setMinAssetValue] = useState(60);
  const [topN, setTopN] = useState(20);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ReachResult | null>(null);

  const sourceZoneLabel = useMemo(() => {
    if (!selectedNode) return null;
    return selectedNode.zone_label || selectedNode.zone_id || null;
  }, [selectedNode]);

  const run = useCallback(async () => {
    if (!selectedNodeId) {
      setResult(null);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/analysis/reachable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: selectedNodeId, maxHops, topN, minAssetValue }),
      });
      const body = (await res.json().catch(() => null)) as ReachResult | null;
      if (res.ok && body?.success) {
        setResult({ ...body, computedBy: 'neo4j' });
        return;
      }
      // 服务端不可用（Neo4j 未连接等）→ 本地回退
      if (data) {
        setResult({
          ...computeLocally(data, selectedNodeId, maxHops, topN, minAssetValue),
          error: body?.error ? `服务端不可用（${body.error}），已回退到本地计算` : undefined,
        });
      } else {
        setResult({ success: false, error: body?.error || `分析失败（HTTP ${res.status}）` });
      }
    } catch (err) {
      if (data) {
        setResult({
          ...computeLocally(data, selectedNodeId, maxHops, topN, minAssetValue),
          error: `服务端不可用（${err instanceof Error ? err.message : '网络错误'}），已回退到本地计算`,
        });
      } else {
        setResult({ success: false, error: err instanceof Error ? err.message : '请求失败' });
      }
    } finally {
      setLoading(false);
    }
  }, [selectedNodeId, maxHops, topN, minAssetValue, data]);

  useEffect(() => {
    run();
  }, [run]);

  const crossCount = result?.targets?.filter(t => t.isCrossDomain).length ?? 0;

  return (
    <div className="space-y-3">
      {/* 标题 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Radar className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">横向可达性</span>
        </div>
        {result?.computedBy && (
          <Badge variant="outline" className="text-[10px] px-1 py-0">
            {result.computedBy === 'neo4j' ? 'Neo4j 全量图' : '本地回退'}
          </Badge>
        )}
      </div>

      {!selectedNodeId && (
        <div className="text-xs text-muted-foreground text-center py-4 border border-dashed border-border/50 rounded-md">
          选中一个节点后，分析它能摸到哪些高价值资产
        </div>
      )}

      {selectedNodeId && (
        <>
          <div className="rounded-md bg-secondary/40 border border-border/60 px-3 py-2 space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground">起点</span>
              <span className="text-xs font-mono font-medium text-foreground">{selectedNodeId}</span>
            </div>
            {sourceZoneLabel && (
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground">所属域</span>
                <span className="text-[11px] text-foreground">{sourceZoneLabel}</span>
              </div>
            )}
            {selectedNode?.asset_value != null && (
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground">资产价值</span>
                <span className="text-[11px] font-mono text-foreground">{Number(selectedNode.asset_value).toFixed(1)}</span>
              </div>
            )}
          </div>

          {/* 参数 */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground w-14 shrink-0">跳数</span>
              <div className="flex gap-1 flex-1">
                {[1, 2, 3].map(h => (
                  <button
                    key={h}
                    onClick={() => setMaxHops(h)}
                    className={`flex-1 py-1 rounded text-[11px] font-mono transition-colors ${
                      maxHops === h
                        ? 'bg-primary/15 text-primary border border-primary/40'
                        : 'bg-secondary/40 text-muted-foreground border border-border/60 hover:text-foreground'
                    }`}
                  >
                    {h} 跳
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground w-14 shrink-0">价值≥</span>
              <div className="flex gap-1 flex-1">
                {[0, 50, 60, 65].map(v => (
                  <button
                    key={v}
                    onClick={() => setMinAssetValue(v)}
                    className={`flex-1 py-1 rounded text-[11px] font-mono transition-colors ${
                      minAssetValue === v
                        ? 'bg-primary/15 text-primary border border-primary/40'
                        : 'bg-secondary/40 text-muted-foreground border border-border/60 hover:text-foreground'
                    }`}
                  >
                    {v === 0 ? '不限' : v}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground w-14 shrink-0">显示</span>
              <div className="flex gap-1 flex-1">
                {[10, 20, 50].map(v => (
                  <button
                    key={v}
                    onClick={() => setTopN(v)}
                    className={`flex-1 py-1 rounded text-[11px] font-mono transition-colors ${
                      topN === v
                        ? 'bg-primary/15 text-primary border border-primary/40'
                        : 'bg-secondary/40 text-muted-foreground border border-border/60 hover:text-foreground'
                    }`}
                  >
                    Top {v}
                  </button>
                ))}
              </div>
            </div>
            <Button size="sm" className="w-full h-8 text-xs" onClick={run} disabled={loading}>
              {loading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Crosshair className="w-3 h-3 mr-1" />}
              {loading ? '分析中…' : '重新分析'}
            </Button>
          </div>

          <Separator />

          {/* 结果 */}
          {result?.error && (
            <div className="flex items-start gap-1.5 px-2 py-1.5 rounded-md bg-amber-500/10 border border-amber-500/20">
              <AlertCircle className="w-3 h-3 text-amber-400 shrink-0 mt-0.5" />
              <span className="text-[10px] text-amber-300">{result.error}</span>
            </div>
          )}

          {result?.success && (
            <>
              <div className="grid grid-cols-3 gap-1.5">
                <div className="rounded-md bg-secondary/30 px-2 py-1.5">
                  <div className="text-[10px] text-muted-foreground">可达</div>
                  <div className="text-sm font-semibold font-mono text-foreground">{result.reached ?? 0}</div>
                </div>
                <div className="rounded-md bg-secondary/30 px-2 py-1.5">
                  <div className="text-[10px] text-muted-foreground">高价值</div>
                  <div className="text-sm font-semibold font-mono text-amber-400">{result.highValueReached ?? 0}</div>
                </div>
                <div className="rounded-md bg-secondary/30 px-2 py-1.5">
                  <div className="text-[10px] text-muted-foreground">跨域</div>
                  <div className="text-sm font-semibold font-mono text-destructive">{crossCount}</div>
                </div>
              </div>

              {result.byHop && result.byHop.length > 0 && (
                <div className="flex gap-2 text-[11px]">
                  {result.byHop.map(h => (
                    <span key={h.hops} className="px-2 py-1 rounded bg-secondary/40 text-muted-foreground">
                      {h.hops} 跳 {h.nodes}
                    </span>
                  ))}
                </div>
              )}

              {/* 高价值目标列表 */}
              <div>
                <div className="text-[11px] text-muted-foreground font-medium mb-1.5 flex items-center gap-1">
                  <ShieldAlert className="w-3 h-3" />
                  可达的高价值资产（按价值降序）
                </div>
                {(!result.targets || result.targets.length === 0) ? (
                  <div className="text-[11px] text-muted-foreground text-center py-3">
                    该范围内没有达到价值门槛的资产
                  </div>
                ) : (
                  <div className="space-y-1 max-h-[280px] overflow-y-auto pr-1 scrollbar-thin">
                    {result.targets.map(t => {
                      const node = data?.nodes.find(n => n.id === t.id);
                      return (
                        <div
                          key={t.id}
                          className={`text-[11px] p-1.5 rounded font-mono cursor-pointer transition-colors ${
                            t.isCrossDomain
                              ? 'bg-destructive/10 border border-destructive/25 hover:bg-destructive/15'
                              : 'bg-secondary/30 hover:bg-secondary/50'
                          }`}
                          onClick={() => node && onNodeSelect?.(node)}
                          title={t.isCrossDomain ? '跨安全域可达' : '同安全域'}
                        >
                          <div className="flex items-center gap-1">
                            <span className={`tabular-nums shrink-0 ${t.assetValue >= 65 ? 'text-amber-400' : 'text-muted-foreground'}`}>
                              {t.assetValue.toFixed(1)}
                            </span>
                            <span className="text-foreground truncate flex-1">{t.id}</span>
                            <span className="text-muted-foreground shrink-0">{t.hops}跳</span>
                            {t.isCrossDomain && <ArrowRight className="w-2.5 h-2.5 text-destructive shrink-0" />}
                          </div>
                          <div className="text-[10px] text-muted-foreground mt-0.5 truncate">
                            {t.zoneLabel || t.zoneId || '未分区'} · {t.role ? (ROLE_LABELS[t.role] || t.role) : '未知角色'} · 度 {t.degree}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
                跨域可达（红色）表示从起点可以不经过额外跳板就摸到别的安全域资产 —— 排查横向移动时优先看这些。
                点击条目可在图上选中该节点。
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
