'use client';

import { useState, useMemo } from 'react';
import {
  Activity, Network, TrendingUp, Loader2, CheckCircle2, AlertCircle,
  RefreshCw, Layers, Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  runGDSAnalysis,
  getGDSStatus,
  type GDSAlgorithm,
  type GDSRunResponse,
  type GDSZoneDetail,
} from '@/lib/topology-api';

interface GDSZone {
  algorithm: string;
  zone_count: number;
  total_ips: number;
}
interface PRNode { ip: string; score: number; }

interface GDSPanelProps {
  onAnalysisComplete?: () => void;
}

export function GDSPanel({ onAnalysisComplete }: GDSPanelProps) {
  const [running, setRunning] = useState<GDSAlgorithm | null>(null);
  const [status, setStatus] = useState<{
    zones: GDSZone[];
    topPageRank: PRNode[];
    zoneDetails: GDSZoneDetail[];
  } | null>(null);
  const [lastRun, setLastRun] = useState<GDSRunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [maxLevels, setMaxLevels] = useState(2);
  const [hoveredZone, setHoveredZone] = useState<GDSZoneDetail | null>(null);

  const loadStatus = async () => {
    try {
      const s = await getGDSStatus();
      setStatus(s);
      setError(null);
    } catch (e: any) {
      setStatus(null);
      setError(e?.message || 'GDS 状态加载失败');
    }
  };

  const run = async (algorithm: GDSAlgorithm) => {
    setRunning(algorithm);
    setError(null);
    try {
      const res = await runGDSAnalysis(algorithm, true, maxLevels);
      if (!res.success) {
        setError(res.error || '运行失败');
        return;
      }
      setLastRun(res);
      await loadStatus();
      onAnalysisComplete?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRunning(null);
    }
  };

  // 选 Louvain 的域详情作为"一条线"展示（用户最关心的分区结果）
  const louvainZones = useMemo(() => {
    if (!status?.zoneDetails) return [];
    return status.zoneDetails.filter((z) => z.algorithm === 'louvain');
  }, [status]);

  const stats = useMemo(() => {
    if (louvainZones.length === 0) return null;
    const counts = louvainZones.map((z) => z.ip_count);
    const total = counts.reduce((a, b) => a + b, 0);
    return {
      total,
      zones: louvainZones.length,
      max: Math.max(...counts),
      min: Math.min(...counts),
      avg: (total / louvainZones.length).toFixed(1),
    };
  }, [louvainZones]);

  return (
    <div className="space-y-2.5">
      {/* 标题栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Layers className="w-3.5 h-3.5 text-muted-foreground" />
          <h3 className="text-xs font-medium text-foreground">
            图算法分区
          </h3>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={loadStatus}
          className="h-6 px-2 text-[11px]"
          title="刷新已持久化的分区状态"
        >
          <RefreshCw className="w-3 h-3" />
        </Button>
      </div>

      {/* 分辨率滑块 */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">
            分区层级（越小越细）
          </span>
          <span className="text-xs font-mono font-semibold text-foreground tabular-nums">
            {maxLevels}
          </span>
        </div>
        <input
          type="range"
          min={1}
          max={10}
          step={1}
          value={maxLevels}
          onChange={(e) => setMaxLevels(parseInt(e.target.value))}
          className="w-full h-1.5 appearance-none rounded-full bg-primary/15 cursor-pointer
            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
            [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary
            [&::-webkit-slider-thumb]:cursor-pointer"
        />
        <div className="flex justify-between text-[10px] font-mono text-muted-foreground/60">
          <span>细</span>
          <span>粗</span>
        </div>
      </div>

      {/* 算法按钮 - 紧凑横排 */}
      <div className="grid grid-cols-2 gap-1.5">
        <Button
          onClick={() => run('louvain')}
          disabled={running !== null}
          size="sm"
          variant="outline"
          className="h-7 text-[11px]"
        >
          {running === 'louvain' ? (
            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
          ) : (
            <Network className="w-3 h-3 mr-1 text-muted-foreground" />
          )}
          Louvain
        </Button>
        <Button
          onClick={() => run('wcc')}
          disabled={running !== null}
          size="sm"
          variant="outline"
          className="h-7 text-[11px]"
        >
          {running === 'wcc' ? (
            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
          ) : (
            <Layers className="w-3 h-3 mr-1 text-muted-foreground" />
          )}
          WCC
        </Button>
        <Button
          onClick={() => run('pagerank')}
          disabled={running !== null}
          size="sm"
          variant="outline"
          className="h-7 text-[11px]"
        >
          {running === 'pagerank' ? (
            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
          ) : (
            <TrendingUp className="w-3 h-3 mr-1 text-muted-foreground" />
          )}
          PageRank
        </Button>
        <Button
          onClick={() => run('all')}
          disabled={running !== null}
          size="sm"
          className="h-7 text-[11px]"
        >
          {running === 'all' ? (
            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
          ) : (
            <Activity className="w-3 h-3 mr-1" />
          )}
          全量分析
        </Button>
      </div>

      {/* ====== 核心：安全域"一条线"展示 ====== */}
      {stats && (
        <div className="border border-border/60 bg-secondary/40 rounded-md p-2.5 space-y-2">
          {/* 大数字 */}
          <div className="flex items-end justify-between">
            <div>
              <div className="text-[11px] text-muted-foreground">
                安全域总数
              </div>
              <div className="text-3xl font-mono font-bold text-foreground leading-none tabular-nums">
                {stats.zones}
              </div>
            </div>
            <div className="text-right space-y-0.5">
              <div className="text-[11px] font-mono text-muted-foreground">
                {stats.total} IP · {stats.zones} 域
              </div>
              <div className="text-[11px] font-mono text-muted-foreground/70">
                最大 {stats.max} · 最小 {stats.min} · 均 {stats.avg}
              </div>
            </div>
          </div>

          {/* 一条线：每个色段 = 一个安全域，宽度 = IP 占比 */}
          <div
            className="flex h-5 rounded-full overflow-hidden border border-border/60"
            title={`${stats.zones} 个安全域`}
          >
            {louvainZones.map((z, i) => {
              const widthPct = (z.ip_count / stats.total) * 100;
              return (
                <div
                  key={`${z.algorithm}-${z.community}`}
                  className="h-full transition-colors duration-200 cursor-pointer relative group"
                  style={{
                    backgroundColor: z.color,
                    width: `${widthPct}%`,
                    minWidth: widthPct < 0.5 ? '1px' : undefined,
                  }}
                  onMouseEnter={() => setHoveredZone(z)}
                  onMouseLeave={() => setHoveredZone(null)}
                />
              );
            })}
          </div>

          {/* hover 详情 */}
          {hoveredZone && (
            <div className="flex items-center gap-2 text-[11px] font-mono">
              <div
                className="w-2.5 h-2.5 rounded-sm shrink-0"
                style={{ backgroundColor: hoveredZone.color }}
              />
              <span className="text-foreground">{hoveredZone.label}</span>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground">{hoveredZone.ip_count} IP</span>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground">
                {((hoveredZone.ip_count / stats.total) * 100).toFixed(1)}%
              </span>
            </div>
          )}
        </div>
      )}

      {/* 算法状态概览 - 紧凑单行 */}
      {status && Array.isArray(status.zones) && status.zones.length > 0 && (
        <div className="flex gap-1.5 text-[11px] font-mono">
          {status.zones.map((z) => (
            <div
              key={z.algorithm}
              className="flex items-center gap-1 border border-border/50 rounded px-1.5 py-0.5"
            >
              <span className="text-muted-foreground">{z.algorithm}</span>
              <span className="text-foreground font-semibold tabular-nums">{z.zone_count}</span>
            </div>
          ))}
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div className="border border-red-500/40 bg-red-500/10 rounded px-2 py-1.5 flex gap-1.5 items-start">
          <AlertCircle className="w-3 h-3 mt-0.5 text-red-400 shrink-0" />
          <span className="text-[10px] font-mono text-red-300 break-all">{error}</span>
        </div>
      )}

      {/* 最近一次结果 - 极简 */}
      {lastRun?.success && (
        <div className="space-y-1.5 text-[11px] font-mono">
          {lastRun.graph && (
            <div className="text-muted-foreground flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3 text-success" />
              图投影 {lastRun.graph.nodeCount} 节点 / {lastRun.graph.relationshipCount} 边
              {lastRun.maxLevels && (
                <Badge className="h-4 text-[10px] bg-secondary text-muted-foreground border-0 ml-1">
                  层级 {lastRun.maxLevels}
                </Badge>
              )}
            </div>
          )}
          {lastRun.louvain && (
            <div className="flex items-center gap-1">
              <span className="text-foreground">Louvain</span>
              <Badge className="h-4 text-[10px] bg-secondary text-muted-foreground border-0">
                {lastRun.louvain.communities} 社区
              </Badge>
            </div>
          )}
          {lastRun.wcc && (
            <div className="flex items-center gap-1">
              <span className="text-foreground">WCC</span>
              <Badge className="h-4 text-[10px] bg-secondary text-muted-foreground border-0">
                {lastRun.wcc.components} 分量
              </Badge>
            </div>
          )}
          {lastRun.pagerank?.top && lastRun.pagerank.top.length > 0 && (
            <div className="border-l-2 border-border pl-2 space-y-0.5">
              <div className="text-muted-foreground flex items-center gap-1">
                <Zap className="w-3 h-3" />
                PageRank 前 3
              </div>
              {lastRun.pagerank.top.slice(0, 3).map((p, i) => (
                <div key={p.ip} className="text-muted-foreground flex gap-1">
                  <span className="text-muted-foreground/60 w-3 text-right tabular-nums">{i + 1}.</span>
                  <span className="text-foreground/90">{p.ip}</span>
                  <span className="text-warning ml-auto tabular-nums">{p.score.toFixed(4)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
