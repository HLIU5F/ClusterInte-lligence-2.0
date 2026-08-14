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
    } catch (e: any) {
      setError(e.message);
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
          <Layers className="w-3.5 h-3.5 text-cyan-400" />
          <h3 className="text-[11px] font-mono tracking-wider text-cyan-400 uppercase">
            GDS 动态分区
          </h3>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={loadStatus}
          className="h-6 px-2 text-[10px]"
          title="刷新已持久化的 GDS 状态"
        >
          <RefreshCw className="w-3 h-3" />
        </Button>
      </div>

      {/* 分辨率滑块 */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono text-cyan-400/60">
            层级 MaxLevels (值越小→社区越多)
          </span>
          <span className="text-[11px] font-mono font-semibold text-cyan-300 tabular-nums">
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
          className="w-full h-1.5 appearance-none rounded-full bg-cyan-400/15 cursor-pointer
            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
            [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-cyan-400
            [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-lg [&::-webkit-slider-thumb]:shadow-cyan-400/50"
        />
        <div className="flex justify-between text-[8px] font-mono text-cyan-400/30">
          <span>细 1</span>
          <span>中 5.0</span>
          <span>粗 10</span>
        </div>
      </div>

      {/* 算法按钮 - 紧凑横排 */}
      <div className="grid grid-cols-2 gap-1.5">
        <Button
          onClick={() => run('louvain')}
          disabled={running !== null}
          size="sm"
          variant="outline"
          className="h-7 text-[10px] border-cyan-400/20 hover:border-cyan-400/50"
        >
          {running === 'louvain' ? (
            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
          ) : (
            <Network className="w-3 h-3 mr-1 text-cyan-400" />
          )}
          Louvain
        </Button>
        <Button
          onClick={() => run('wcc')}
          disabled={running !== null}
          size="sm"
          variant="outline"
          className="h-7 text-[10px] border-cyan-400/20 hover:border-cyan-400/50"
        >
          {running === 'wcc' ? (
            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
          ) : (
            <Layers className="w-3 h-3 mr-1 text-cyan-400" />
          )}
          WCC
        </Button>
        <Button
          onClick={() => run('pagerank')}
          disabled={running !== null}
          size="sm"
          variant="outline"
          className="h-7 text-[10px] border-cyan-400/20 hover:border-cyan-400/50"
        >
          {running === 'pagerank' ? (
            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
          ) : (
            <TrendingUp className="w-3 h-3 mr-1 text-cyan-400" />
          )}
          PageRank
        </Button>
        <Button
          onClick={() => run('all')}
          disabled={running !== null}
          size="sm"
          className="h-7 text-[10px] bg-cyan-400/20 hover:bg-cyan-400/30 text-cyan-300"
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
        <div className="border border-cyan-400/15 bg-[#0c1428] rounded-md p-2.5 space-y-2">
          {/* 大数字 */}
          <div className="flex items-end justify-between">
            <div>
              <div className="text-[11px] font-mono text-cyan-400/50 uppercase tracking-wider">
                安全域总数
              </div>
              <div className="text-3xl font-mono font-bold text-cyan-300 leading-none tabular-nums">
                {stats.zones}
              </div>
            </div>
            <div className="text-right space-y-0.5">
              <div className="text-[11px] font-mono text-cyan-400/50">
                {stats.total} IPs / {stats.zones} 域
              </div>
              <div className="text-[11px] font-mono text-cyan-400/40">
                最大 {stats.max} · 最小 {stats.min} · 均 {stats.avg}
              </div>
            </div>
          </div>

          {/* 一条线：每个色段 = 一个安全域，宽度 = IP 占比 */}
          <div
            className="flex h-5 rounded-full overflow-hidden border border-cyan-400/10"
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
            <div className="flex items-center gap-2 text-[10px] font-mono">
              <div
                className="w-2.5 h-2.5 rounded-sm shrink-0"
                style={{ backgroundColor: hoveredZone.color }}
              />
              <span className="text-cyan-300">{hoveredZone.label}</span>
              <span className="text-cyan-400/50">·</span>
              <span className="text-cyan-400/70">{hoveredZone.ip_count} IPs</span>
              <span className="text-cyan-400/50">·</span>
              <span className="text-cyan-400/50">
                {((hoveredZone.ip_count / stats.total) * 100).toFixed(1)}%
              </span>
            </div>
          )}
        </div>
      )}

      {/* 算法状态概览 - 紧凑单行 */}
      {status && status.zones.length > 0 && (
        <div className="flex gap-1.5 text-[11px] font-mono">
          {status.zones.map((z) => (
            <div
              key={z.algorithm}
              className="flex items-center gap-1 border border-cyan-400/10 rounded px-1.5 py-0.5"
            >
              <span className="text-cyan-400/50 uppercase">{z.algorithm}</span>
              <span className="text-cyan-300 font-semibold tabular-nums">{z.zone_count}</span>
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
        <div className="space-y-1 text-[10px] font-mono">
          {lastRun.graph && (
            <div className="text-cyan-400/50 flex items-center gap-1">
              <CheckCircle2 className="w-2.5 h-2.5 text-cyan-400" />
              投影 {lastRun.graph.nodeCount} 节点 / {lastRun.graph.relationshipCount} 边
              {lastRun.maxLevels && (
                <Badge className="h-3.5 text-[8px] bg-cyan-400/15 text-cyan-400 border-0 ml-1">
                  层级={lastRun.maxLevels}
                </Badge>
              )}
            </div>
          )}
          {lastRun.louvain && (
            <div className="flex items-center gap-1">
              <span className="text-cyan-300">Louvain</span>
              <Badge className="h-3.5 text-[8px] bg-cyan-400/20 text-cyan-300 border-0">
                {lastRun.louvain.communities} 社区
              </Badge>
            </div>
          )}
          {lastRun.wcc && (
            <div className="flex items-center gap-1">
              <span className="text-purple-300">WCC</span>
              <Badge className="h-3.5 text-[8px] bg-purple-400/20 text-purple-300 border-0">
                {lastRun.wcc.components} 分量
              </Badge>
            </div>
          )}
          {lastRun.pagerank?.top && lastRun.pagerank.top.length > 0 && (
            <div className="border-l-2 border-orange-400/40 pl-2 space-y-0.5">
              <div className="text-orange-300/80 flex items-center gap-1">
                <Zap className="w-2.5 h-2.5" />
                PageRank Top 3
              </div>
              {lastRun.pagerank.top.slice(0, 3).map((p, i) => (
                <div key={p.ip} className="text-cyan-400/60 flex gap-1">
                  <span className="text-orange-400/60 w-3 text-right">{i + 1}.</span>
                  <span className="text-cyan-300/80">{p.ip}</span>
                  <span className="text-orange-400/50 ml-auto">{p.score.toFixed(4)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
