"use client";
import { useState, useCallback, useMemo, useRef, useEffect, startTransition } from 'react';
import dynamic from 'next/dynamic';
import { TopologyGraph } from '@/components/topology-graph';
import type { TopologyData, TopologyNode, TopologyLink, BaselineRule, WhitelistRule, GDSHubNode, GdsRunInfo, GraphLayoutPreset, GraphPhysics } from '@/lib/types';
import { communityColor, getAnomalyLevel } from '@/lib/types';
import { loadFromNeo4j } from "@/lib/topology-api";
import { computeClustering, ClusteringStrategy, deriveZoneLabel, SecurityV3Granularity } from '@/lib/clustering';
import { buildLocalGdsData, buildAttrSubZoneIndex } from '@/lib/localGds';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import {
  Tooltip, TooltipContent, TooltipTrigger, TooltipProvider,
} from '@/components/ui/tooltip';
import {
  FolderOpen, Puzzle, Shield, BarChart3, Search, Network, Upload, Database, Orbit, Layers,
  Settings, X, Sun, Moon, RefreshCw,
} from 'lucide-react';

const DataSourcePanel = dynamic(() => import('@/components/panels').then(m => m.DataSourcePanel), { ssr: false });
const AlgorithmPanel = dynamic(() => import('@/components/panels').then(m => m.AlgorithmPanel), { ssr: false });
const SecurityPanel = dynamic(() => import('@/components/panels').then(m => m.SecurityPanel), { ssr: false });
const StatsPanel = dynamic(() => import('@/components/panels').then(m => m.StatsPanel), { ssr: false });
const InspectorPanel = dynamic(() => import('@/components/inspector-panel').then(m => m.InspectorPanel), { ssr: false });

const DEFAULT_BASELINE_RULES: BaselineRule[] = [
  {
    id: 'rule-1',
    name: '异常分数过高',
    description: '异常分数超过 0.75 的节点需立即排查',
    field: 'anomaly_score',
    operator: 'gt',
    threshold: 0.75,
    severity: 'critical',
    enabled: true,
  },
  {
    id: 'rule-2',
    name: '异常分数偏高',
    description: '异常分数超过 0.60 的节点建议关注',
    field: 'anomaly_score',
    operator: 'gt',
    threshold: 0.60,
    severity: 'high',
    enabled: false,
  },
  {
    id: 'rule-3',
    name: '大数据量传输',
    description: '单个连接发送超过 40MB 建议检查',
    field: 'bytes_sent',
    operator: 'gt',
    threshold: 40 * 1024 * 1024,
    severity: 'medium',
    enabled: false,
  },
  {
    id: 'rule-4',
    name: '高度中心性枢纽',
    description: '连接数超过 35 的高度中心性节点建议关注',
    field: 'degree',
    operator: 'gt',
    threshold: 35,
    severity: 'low',
    enabled: false,
  },
];

function buildGdsRunInfo(algorithm: 'louvain' | 'wcc', runResult: any): GdsRunInfo {
  const info = algorithm === 'louvain' ? runResult?.louvain : runResult?.wcc;
  if (algorithm === 'louvain') {
    return {
      algorithm,
      source: 'neo4j',
      baseZones: info?.physical_zone?.zones ?? info?.communities ?? 0,
      modularity: info?.modularity != null ? Number(info.modularity) : null,
      fallback: !!info?.fallback,
      fallbackReason: info?.fallback
        ? (Number(info?.communities ?? 1) < 2
          ? `社区数不足（${info?.communities}）`
          : '模块度过低')
        : '',
      physicalZoneZones: info?.physical_zone?.zones,
      graphNodes: runResult?.graph?.nodeCount,
      graphLinks: runResult?.graph?.relationshipCount,
      ranAt: new Date().toISOString(),
    };
  }
  return {
    algorithm,
    source: 'neo4j',
    baseZones: info?.components ?? 0,
    modularity: null,
    fallback: false,
    fallbackReason: '',
    graphNodes: runResult?.graph?.nodeCount,
    graphLinks: runResult?.graph?.relationshipCount,
    ranAt: new Date().toISOString(),
  };
}

function buildLocalGdsRunInfo(algorithm: 'louvain' | 'wcc', local: any): GdsRunInfo {
  return {
    algorithm,
    source: 'local',
    baseZones: local?.zones?.filter((z: any) => z.algorithm === algorithm).length ?? 0,
    modularity: null,
    fallback: true,
    fallbackReason: 'Neo4j/GDS 不可用，使用本地图算法',
    ranAt: new Date().toISOString(),
  };
}

function expandLocally(nodes: TopologyNode[], links: TopologyLink[], nodeId: string, hops: number) {
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const adj = new Map<string, string[]>();
  links.forEach(l => {
    const srcId = typeof l.source === 'string' ? l.source : l.source.id;
    const tgtId = typeof l.target === 'string' ? l.target : l.target.id;
    if (!adj.has(srcId)) adj.set(srcId, []);
    if (!adj.has(tgtId)) adj.set(tgtId, []);
    adj.get(srcId)!.push(tgtId);
    adj.get(tgtId)!.push(srcId);
  });
  const distances = new Map<string, number>([[nodeId, 0]]);
  const queue = [nodeId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const dist = distances.get(cur)!;
    if (dist >= hops) continue;
    for (const next of adj.get(cur) ?? []) {
      if (!distances.has(next)) {
        distances.set(next, dist + 1);
        queue.push(next);
      }
    }
  }
  const center = nodeById.get(nodeId);
  const neighbors = Array.from(distances.entries())
    .filter(([id]) => id !== nodeId && nodeById.has(id))
    .map(([id, distance]) => ({ ...nodeById.get(id)!, distance }))
    .sort((a, b) => a.distance - b.distance);
  const neighborIds = new Set(neighbors.map(n => n.id));
  neighborIds.add(nodeId);
  const edges = links.flatMap(l => {
    const srcId = typeof l.source === 'string' ? l.source : l.source.id;
    const tgtId = typeof l.target === 'string' ? l.target : l.target.id;
    if (!neighborIds.has(srcId) || !neighborIds.has(tgtId)) return [];
    return [{ source: srcId, target: tgtId, weight: l.weight, bytes: l.bytes ?? 0, ports: (l as any).ports ?? [] }];
  });
  return {
    centerNode: center ? { ...center, distance: 0 } : null,
    neighbors,
    edges,
    totalNodes: neighbors.length + 1,
    totalEdges: edges.length,
    distanceStats: neighbors.reduce<Record<number, number>>((acc, n) => {
      acc[n.distance] = (acc[n.distance] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

export default function Home() {
  const [data, setData] = useState<TopologyData | null>(null);
  const [originalData, setOriginalData] = useState<TopologyData | null>(null);
  const [edgeThreshold, setEdgeThreshold] = useState(0.3);
  const [nodeMinDegree, setNodeMinDegree] = useState(0);
  const [showLabels, setShowLabels] = useState(true);
  const [selectedNode, setSelectedNode] = useState<TopologyNode | null>(null);
  const [highlightedCommunity, setHighlightedCommunity] = useState<number | null>(null);
  const [focusedCommunity, setFocusedCommunity] = useState<number | null>(null);
  const [searchNodeId, setSearchNodeId] = useState<string | null>(null);
  const [baselineRules, setBaselineRules] = useState<BaselineRule[]>(DEFAULT_BASELINE_RULES);
  const [whitelist, setWhitelist] = useState<WhitelistRule[]>([]);
  const [resetKey, setResetKey] = useState(0);
  const [gdsData, setGdsData] = useState<{ nodes: any[]; zones: any[]; hubNodes: GDSHubNode[] } | null>(null);
  const [gdsAlgorithm, setGdsAlgorithm] = useState<'louvain' | 'wcc' | 'original'>('original');
  const [runningGds, setRunningGds] = useState(false);
  const [gdsRunInfo, setGdsRunInfo] = useState<GdsRunInfo | null>(null);
  const [clusteringStrategy, setClusteringStrategy] = useState<ClusteringStrategy | null>(null);
  const [clusteringResult, setClusteringResult] = useState<any>(null);
  const [securityGranularity, setSecurityGranularity] = useState<SecurityV3Granularity>('standard');
  const [securityEnrich, setSecurityEnrich] = useState(false);
  const [pathNodeIds, setPathNodeIds] = useState<string[]>([]);
  const [pathEdges, setPathEdges] = useState<any[]>([]);
  const [expansionNodes, setExpansionNodes] = useState<any[]>([]);
  const [expansionEdges, setExpansionEdges] = useState<any[]>([]);
  const [layoutPreset, setLayoutPreset] = useState<GraphLayoutPreset>('force');
  const [graphPhysics, setGraphPhysics] = useState<GraphPhysics>({
    linkDistance: 80,
    chargeStrength: -300,
    centerStrength: 0.2,
    collideRadius: 5,
  });

  // Drawer states
  const [dataSourceOpen, setDataSourceOpen] = useState(false);
  const [algorithmOpen, setAlgorithmOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // 抽屉宽度（边缘可拖拽调节，左侧 4 个抽屉共享，右侧设置独立）
  const [drawerWidth, setDrawerWidth] = useState(400);
  const [settingsWidth, setSettingsWidth] = useState(360);
  const startResize = useCallback((side: 'left' | 'right') => (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = side === 'left' ? drawerWidth : settingsWidth;
    const onMove = (ev: PointerEvent) => {
      const w = side === 'left'
        ? Math.min(640, Math.max(320, startW + (ev.clientX - startX)))
        : Math.min(560, Math.max(280, startW - (ev.clientX - startX)));
      if (side === 'left') setDrawerWidth(w);
      else setSettingsWidth(w);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [drawerWidth, settingsWidth]);

  // 主题：默认暗黑，通过 data-theme 属性切换并持久化
  const [darkMode, setDarkMode] = useState<boolean>(true);

  // 首帧保持与服务端一致，挂载后再应用已保存的主题偏好
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('ci-theme') ?? window.localStorage.getItem('ci-dark-mode');
      if (saved === 'light' || saved === 'false') setDarkMode(false);
    } catch {}
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = darkMode ? 'dark' : 'light';
    root.classList.toggle('dark', darkMode);
    root.classList.toggle('light', !darkMode);
    try {
      window.localStorage.setItem('ci-theme', darkMode ? 'dark' : 'light');
      window.localStorage.setItem('ci-dark-mode', String(darkMode));
    } catch {}
  }, [darkMode]);

  // Header search
  const [headerSearchQuery, setHeaderSearchQuery] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImportData = useCallback((newData: TopologyData) => {
    const normalizedData: TopologyData = {
      ...newData,
      metadata: {
        ...(newData.metadata ?? ({} as TopologyData['metadata'])),
        total_nodes: newData.nodes.length,
        total_links: newData.links.length,
        communities: new Set(newData.nodes.map((n: TopologyNode) => n.community)).size,
      },
    };
    const original = JSON.parse(JSON.stringify(normalizedData));
    setData(normalizedData);
    setOriginalData(original);
    setSelectedNode(null);
    setHighlightedCommunity(null);
    setFocusedCommunity(null);
    setResetKey(k => k + 1);
    setGdsAlgorithm('original');
    setGdsData(null);
    setGdsRunInfo(null);
    startTransition(() => {
      const v3Result = computeClustering(normalizedData.nodes, normalizedData.links, 'security_v3', securityGranularity, securityEnrich);
      setClusteringStrategy('security_v3');
      setClusteringResult(v3Result);
      setDataSourceOpen(false);
    });
  }, [securityGranularity, securityEnrich]);

  const handleFileImport = useCallback(async (file: File) => {
    const isExcel = file.name.endsWith('.xlsx') || file.name.endsWith('.xls');
    const isJSON = file.name.endsWith('.json');
    if (isExcel) {
      try {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch('/api/import', { method: 'POST', body: formData });
        const result = await res.json();
        if (result.success && result.data) {
          handleImportData(result.data);
        } else {
          alert(`导入失败: ${result.error || '未知错误'}`);
        }
      } catch {
        alert('数据格式解析失败，请检查 JSON 格式是否正确');
      }
    } else if (isJSON) {
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const json = JSON.parse(event.target?.result as string);
          if (json.nodes && json.links) {
            json.nodes = json.nodes.map((n: TopologyNode) => ({
              ...n,
              anomaly_level: n.anomaly_level || getAnomalyLevel(n.anomaly_score),
              is_anomaly: n.is_whitelisted ? false : (n.is_anomaly ?? (n.anomaly_score > 0.6 || n.anomaly_level === 'Critical' || n.anomaly_level === 'High')),
            }));
            if (!json.metadata) {
              json.metadata = {
                generated_at: new Date().toISOString().split('T')[0],
                source: file.name,
                total_nodes: json.nodes.length,
                total_links: json.links.length,
                communities: new Set(json.nodes.map((n: TopologyNode) => n.community)).size,
              };
            }
            handleImportData(json);
          }
        } catch {
          alert('JSON 数据解析失败，请检查数据格式是否正确');
        }
      };
      reader.readAsText(file);
    } else {
      alert('不支持的文件格式，请上传 .xlsx 或 .json 文件');
    }
  }, [handleImportData]);

  const handleSearchNode = useCallback((id: string) => {
    setSearchNodeId(id);
    setFocusedCommunity(null);
    setTimeout(() => setSearchNodeId(null), 3500);
  }, []);

  const handleResetView = useCallback(() => {
    setResetKey(k => k + 1);
    setSelectedNode(null);
    setHighlightedCommunity(null);
    setFocusedCommunity(null);
  }, []);

  const handleToggleFocus = useCallback((communityId: number | null) => {
    setFocusedCommunity(prev => prev === communityId ? null : communityId);
    setResetKey(k => k + 1);
  }, []);

  const handleNodeSelect = useCallback((node: TopologyNode | null) => {
    setSelectedNode(node);
  }, []);

  const handleAddToWhitelist = useCallback((entry: Omit<WhitelistRule, 'id' | 'addedAt'>) => {
    setWhitelist(prev => [...prev, { ...entry, id: `wl-${Date.now()}`, addedAt: new Date().toISOString() }]);
  }, []);

  const [loading, setLoading] = useState(false);

  const handleLoadFromNeo4j = useCallback(async () => {
    setLoading(true);
    try {
      const neo4jData = await loadFromNeo4j(true);
      if (!neo4jData.nodes || neo4jData.nodes.length === 0) {
        alert('Neo4j 中暂无拓扑数据，请先用脚本向 Neo4j 导入数据');
        return;
      }
      // 只加载有连接关系的节点（≈ 核心图规模），避免一次性渲染数千个孤立节点卡死；
      // Neo4j 里的全量数据保留，供 APOC / Cypher 查询使用。
      const linkNodeIds = new Set<string>();
      neo4jData.links.forEach(l => {
        linkNodeIds.add(l.source);
        linkNodeIds.add(l.target);
      });
      const connectedNodes = neo4jData.nodes.filter(n => linkNodeIds.has(n.id));
      if (connectedNodes.length === 0) {
        alert('Neo4j 中暂无有连接关系的拓扑数据');
        return;
      }
      const topologyData: TopologyData = {
        nodes: connectedNodes.map(n => ({
          ...n,
          zone: n.zone_id,
          bytes_sent: 0,
          bytes_received: 0,
        })) as TopologyNode[],
        links: neo4jData.links.map(l => ({
          ...l,
          isCrossDomain: l.is_cross_domain,
        })),
        metadata: {
          ...neo4jData.metadata,
          ...({ zones: neo4jData.zones } as any),
          domainNames: Object.fromEntries(
            neo4jData.zones.map(z => [Number(z.id), z.label])
          ),
        },
      };
      handleImportData(topologyData);
    } catch (error) {
      console.error("Neo4j 连接失败:", error);
      alert("无法连接到 Neo4j API，请检查 Neo4j 服务是否正常");
    } finally {
      setLoading(false);
    }
  }, [handleImportData]);

  const handleLoadCoreGraph = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/topology_data_core.json', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      handleImportData(json as TopologyData);
    } catch (error) {
      console.error('加载业务核心图失败:', error);
      alert('无法加载业务核心图，请确认 public/topology_data_core.json 存在');
    } finally {
      setLoading(false);
    }
  }, [handleImportData]);


  const refreshGdsData = useCallback(async () => {
    try {
      const res = await fetch('/api/topology/gds', { cache: 'no-store' });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`GDS 数据加载失败: ${text}`);
      }
      const gdsResult = await res.json();
      setGdsData(gdsResult);
      return gdsResult;
    } catch (error) {
      console.error('刷新 GDS 数据失败:', error);
      setGdsData(null);
      throw error;
    }
  }, []);

  const handleEnrichComplete = useCallback((ip: string, result: { properties?: Record<string, any> }) => {
    const applyEnrich = (current: TopologyData | null): TopologyData | null => {
      if (!current || !result.properties) return current;
      return {
        ...current,
        nodes: current.nodes.map(node => {
          if (node.id !== ip) return node;
          const merged = { ...node, ...result.properties };
          return { ...merged, zone_label: merged.zone_label ?? deriveZoneLabel(merged) };
        }),
      };
    };

    setOriginalData(prev => applyEnrich(prev));
    setData(prev => applyEnrich(prev));
    setSelectedNode(prev => {
      if (!prev || prev.id !== ip) return prev;
      const merged = { ...prev, ...result.properties };
      return { ...merged, zone_label: merged.zone_label ?? deriveZoneLabel(merged) };
    });
  }, []);

  const handleRemoveFromWhitelist = useCallback((id: string) => {
    setWhitelist(prev => prev.filter(e => e.id !== id));
  }, []);

  const handleRunGDS = useCallback(async (algorithm: 'louvain' | 'wcc') => {
    setRunningGds(true);
    try {
      const runRes = await fetch('/api/analysis/gds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm, persist: true, maxLevels: 1 }),
      });
      const runResult = await runRes.json().catch(() => null);
      if (runResult?.success) {
        setGdsRunInfo(buildGdsRunInfo(algorithm, runResult));
        try {
          await refreshGdsData();
          return true;
        } catch {
          // 读取失败时继续走本地兜底
        }
      }
      if (originalData) {
        const local = buildLocalGdsData(originalData.nodes, originalData.links, algorithm);
        if (local && local.nodes.length > 0) {
          setGdsData(local);
          setGdsRunInfo(buildLocalGdsRunInfo(algorithm, local));
          return true;
        }
      }
      return false;
    } catch (error: any) {
      console.error('GDS analysis error:', error);
      if (originalData) {
        const local = buildLocalGdsData(originalData.nodes, originalData.links, algorithm);
        if (local && local.nodes.length > 0) {
          setGdsData(local);
          setGdsRunInfo(buildLocalGdsRunInfo(algorithm, local));
          return true;
        }
      }
      return false;
    } finally {
      setRunningGds(false);
    }
  }, [refreshGdsData, originalData]);

  const hasGdsAlgorithmResults = useCallback((algorithm: 'louvain' | 'wcc') => {
    return !!gdsData?.zones.some((z: any) => z.algorithm === algorithm);
  }, [gdsData]);

  const handleSwitchDomainMode = useCallback(async (mode: 'louvain' | 'wcc' | 'original') => {
    let success = true;
    if (mode !== 'original' && !hasGdsAlgorithmResults(mode)) {
      success = await handleRunGDS(mode);
    }
    if (success) {
      setGdsAlgorithm(mode);
      setClusteringStrategy(null);
      setClusteringResult(null);
      setFocusedCommunity(null);
      setHighlightedCommunity(null);
    } else {
      alert('GDS 分析未返回可用结果（Neo4j/GDS 不可用或社区数不足），已保持当前分区模式');
    }
  }, [handleRunGDS, hasGdsAlgorithmResults]);

  const handleSwitchClustering = useCallback((strategy: ClusteringStrategy | null) => {
    if (strategy === 'zone_label' && (clusteringStrategy === 'security_v3' || clusteringStrategy === 'service_port' || clusteringStrategy === 'flow_anchor')) {
      const nextEnrich = !securityEnrich;
      setSecurityEnrich(nextEnrich);
      setFocusedCommunity(null);
      setHighlightedCommunity(null);
      if (originalData) {
        startTransition(() => {
          const result = computeClustering(originalData.nodes, originalData.links, clusteringStrategy, securityGranularity, nextEnrich);
          setClusteringResult(result);
        });
      }
      return;
    }
    setClusteringStrategy(strategy);
    setFocusedCommunity(null);
    setHighlightedCommunity(null);
    if (strategy !== 'security_v3') setSecurityEnrich(false);
    if (!strategy || !originalData) {
      setClusteringResult(null);
      if (gdsAlgorithm !== 'original') setGdsAlgorithm('original');
      return;
    }
    setGdsAlgorithm('original');
    startTransition(() => {
      const result = computeClustering(originalData.nodes, originalData.links, strategy, securityGranularity, securityEnrich);
      setClusteringResult(result);
    });
  }, [originalData, gdsAlgorithm, securityGranularity, securityEnrich, clusteringStrategy]);

  useEffect(() => {
    if (!clusteringStrategy || !originalData) return;
    const result = computeClustering(originalData.nodes, originalData.links, clusteringStrategy, securityGranularity, securityEnrich);
    setClusteringResult(result);
  }, [clusteringStrategy, originalData, securityGranularity, securityEnrich]);

  const handleSecurityGranularityChange = useCallback((granularity: SecurityV3Granularity) => {
    setSecurityGranularity(granularity);
    if (clusteringStrategy === 'security_v3' && originalData) {
      startTransition(() => {
        const result = computeClustering(originalData.nodes, originalData.links, 'security_v3', granularity, securityEnrich);
        setClusteringResult(result);
      });
    }
  }, [clusteringStrategy, originalData, securityEnrich]);

  const handleSecurityEnrichChange = useCallback((enabled: boolean) => {
    setSecurityEnrich(enabled);
    if (clusteringStrategy === 'security_v3' && originalData) {
      startTransition(() => {
        const result = computeClustering(originalData.nodes, originalData.links, 'security_v3', securityGranularity, enabled);
        setClusteringResult(result);
      });
    }
  }, [clusteringStrategy, originalData, securityGranularity]);

  useEffect(() => {
    if (gdsAlgorithm === 'original' || gdsData) return;
    refreshGdsData().catch(() => {
      // Ignore failures here; page can still work without persisted GDS data.
    });
  }, [gdsAlgorithm, gdsData, refreshGdsData]);

  useEffect(() => {
    if (gdsAlgorithm === 'original') return;
    const hasResults = hasGdsAlgorithmResults(gdsAlgorithm);
    if (!hasResults) {
      refreshGdsData().catch(() => {
        // Best-effort refresh when switching to a new GDS mode.
      });
    }
  }, [gdsAlgorithm, gdsData, hasGdsAlgorithmResults, refreshGdsData]);

  const handleQueryPath = useCallback(async (source: string, target: string) => {
    try {
      const res = await fetch('/api/analysis/path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, target, maxHops: 10 }),
      });
      const data = await res.json();
      if (data.found) {
        setPathNodeIds(data.nodeIds || data.nodes.map((n: any) => n.id));
        setPathEdges(data.edges || []);
      } else {
        setPathNodeIds([]);
        setPathEdges([]);
        alert(data.message || '清除路径失败');
      }
    } catch (err) {
      console.error('Path query failed:', err);
      alert('路径查询失败');
    }
  }, []);

  const handleClearPath = useCallback(() => {
    setPathNodeIds([]);
    setPathEdges([]);
  }, []);

  const handleExpandNeighbors = useCallback(async (nodeId: string, hops: number) => {
    const applyExpansion = (result: { neighbors: any[]; edges?: any[] }) => {
      setExpansionNodes(result.neighbors ?? []);
      setExpansionEdges(result.edges ?? []);
    };
    try {
      const res = await fetch('/api/analysis/neighbors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId, hops }),
      });
      const data = await res.json();
      if (res.ok && data.neighbors) {
        applyExpansion(data);
        return;
      }
    } catch (err) {
      console.error('Neighbor expansion failed:', err);
    }
    if (originalData) {
      applyExpansion(expandLocally(originalData.nodes, originalData.links, nodeId, hops));
    }
  }, [originalData]);

  const handleClearExpansion = useCallback(() => {
    setExpansionNodes([]);
    setExpansionEdges([]);
  }, []);

  // GDS 社区内再做网段/端口/IP块细化，保证分区数量会随 GDS 结果上升
  const attrSubZoneIndex = useMemo(
    () => (originalData ? buildAttrSubZoneIndex(originalData.nodes) : null),
    [originalData]
  );
  // Data pipeline
  const whitelistAdjustedData = useMemo((): TopologyData => {
    if (!originalData) return null as unknown as TopologyData;
    const whitelistIPs = new Set(whitelist.map(w => w.nodeId));
    const gdsMap = new Map<string, { gds_louvain?: number; gds_wcc?: number; gds_pagerank?: number }>();
    if (gdsData && gdsAlgorithm !== 'original') {
      gdsData.nodes.forEach((n: any) => {
        gdsMap.set(n.ip, { gds_louvain: n.gds_louvain, gds_wcc: n.gds_wcc, gds_pagerank: n.gds_pagerank });
      });
    }
    return {
      ...originalData,
      nodes: originalData.nodes.map(node => {
        const isWhitelisted = whitelistIPs.has(node.id);
        const gdsInfo = gdsMap.get(node.id);
        let community = node.community;
        if (gdsInfo) {
          if (gdsAlgorithm === 'louvain' && gdsInfo.gds_louvain != null) {
            community = gdsInfo.gds_louvain * 1000 + (attrSubZoneIndex ? attrSubZoneIndex(node) : 0);
          } else if (gdsAlgorithm === 'wcc' && gdsInfo.gds_wcc != null) {
            community = gdsInfo.gds_wcc * 1000 + (attrSubZoneIndex ? attrSubZoneIndex(node) : 0);
          }
        }
        return {
          ...node,
          is_whitelisted: isWhitelisted,
          is_anomaly: isWhitelisted ? false : node.is_anomaly,
          anomaly_level: isWhitelisted ? ('None' as const) : node.anomaly_level,
          anomaly_score: isWhitelisted ? 0 : node.anomaly_score,
          community,
          gds_louvain: gdsInfo?.gds_louvain,
          gds_wcc: gdsInfo?.gds_wcc,
          gds_pagerank: gdsInfo?.gds_pagerank,
        };
      }),
      links: originalData.links.map(l => ({ ...l })),
    };
  }, [originalData, whitelist, gdsData, gdsAlgorithm]);

  const clusteringAppliedData = useMemo(() => {
    if (!whitelistAdjustedData) return null as unknown as TopologyData;

    const nodes = !clusteringStrategy || !clusteringResult || gdsAlgorithm !== 'original'
      ? whitelistAdjustedData.nodes
      : (() => {
        const zoneMap = new Map<string, number>();
        const zoneIndex = new Map<string, number>();
        for (const z of clusteringResult.zones) {
          let idx = zoneIndex.get(z.zone_id);
          if (idx === undefined) {
            idx = zoneIndex.size;
            zoneIndex.set(z.zone_id, idx);
          }
          zoneMap.set(z.node_id, idx);
        }
        return whitelistAdjustedData.nodes.map(n => ({
          ...n,
          community: zoneMap.has(n.id) ? zoneMap.get(n.id)! : n.community,
        }));
      })();

    const communityCount = new Set(nodes.map(n => n.community)).size;

    return {
      ...whitelistAdjustedData,
      metadata: {
        ...whitelistAdjustedData.metadata,
        communities: communityCount,
      },
      nodes,
    };
  }, [whitelistAdjustedData, clusteringStrategy, clusteringResult, gdsAlgorithm]);

  const filteredData = useMemo((): TopologyData => {
    if (!clusteringAppliedData) return null as unknown as TopologyData;
    // 聚焦安全域（聚焦后数据量小）
    if (focusedCommunity !== null) {
      const domainNodes = clusteringAppliedData.nodes.filter(n => n.community === focusedCommunity);
      if (domainNodes.length > 0) {
        const domainNodeIds = new Set(domainNodes.map(n => n.id));
        const relevantLinks = clusteringAppliedData.links.filter(l => {
          const srcId = typeof l.source === 'string' ? l.source : (l.source as any)?.id;
          const tgtId = typeof l.target === 'string' ? l.target : (l.target as any)?.id;
          return domainNodeIds.has(srcId) || domainNodeIds.has(tgtId);
        });
        const allRelatedNodeIds = new Set<string>();
        domainNodes.forEach(n => allRelatedNodeIds.add(n.id));
        relevantLinks.forEach(l => {
          const srcId = typeof l.source === 'string' ? l.source : (l.source as any)?.id;
          const tgtId = typeof l.target === 'string' ? l.target : (l.target as any)?.id;
          if (srcId) allRelatedNodeIds.add(srcId);
          if (tgtId) allRelatedNodeIds.add(tgtId);
        });
        const allNodes = clusteringAppliedData.nodes.filter(n => allRelatedNodeIds.has(n.id));
        const nodesWithFocusFlag = allNodes.map(n => ({ ...n, isFocusedDomain: domainNodeIds.has(n.id) }));
        const linksWithCrossFlag = relevantLinks.map(l => {
          const srcId = typeof l.source === 'string' ? l.source : (l.source as any)?.id;
          const tgtId = typeof l.target === 'string' ? l.target : (l.target as any)?.id;
          return { ...l, isCrossDomain: !(domainNodeIds.has(srcId) && domainNodeIds.has(tgtId)) };
        });
        return { ...clusteringAppliedData, nodes: nodesWithFocusFlag, links: [...linksWithCrossFlag] };
      }
    }
    // 大图渲染保护：节点 > 1500 时画布只渲染核心节点，避免卡死。
    // 全量数据仍用于聚类/统计（安全域划分不受影响）。
    if (clusteringAppliedData.nodes.length > 1500) {
      const linkedIds = new Set<string>();
      clusteringAppliedData.links.forEach(l => {
        const srcId = typeof l.source === 'string' ? l.source : (l.source as any)?.id;
        const tgtId = typeof l.target === 'string' ? l.target : (l.target as any)?.id;
        if (srcId) linkedIds.add(srcId);
        if (tgtId) linkedIds.add(tgtId);
      });
      let renderNodes = clusteringAppliedData.nodes.filter(n => linkedIds.has(n.id));
      if (renderNodes.length > 1500) {
        // 全星型/超大连通图：异常节点优先保留（必须可见，否则行为导向后的低度异常节点会被挤出画布），
        // 其余按度数取前 600（枢纽 + 繁忙主机）。
        const isAnomalyNode = (n: TopologyNode) =>
          n.is_anomaly || n.anomaly_level === 'Critical' || n.anomaly_level === 'High' || (n.anomaly_score ?? 0) >= 0.45;
        const anomalyNodes = renderNodes.filter(isAnomalyNode);
        const rest = renderNodes
          .filter(n => !isAnomalyNode(n))
          .sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0));
        const budget = Math.max(600 - anomalyNodes.length, 0);
        renderNodes = [...anomalyNodes, ...rest.slice(0, budget)];
      }
      return { ...clusteringAppliedData, nodes: renderNodes };
    }
    return clusteringAppliedData;
  }, [clusteringAppliedData, focusedCommunity]);

  const handleHeaderSearch = useCallback(() => {
    if (headerSearchQuery.trim()) handleSearchNode(headerSearchQuery.trim());
  }, [headerSearchQuery, handleSearchNode]);

  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); setIsDragOver(true); }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => { e.preventDefault(); setIsDragOver(false); }, []);
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files.length > 0) handleFileImport(e.dataTransfer.files[0]);
  }, [handleFileImport]);

  const activeDrawer = dataSourceOpen ? 'datasource' : algorithmOpen ? 'algorithm' : securityOpen ? 'security' : statsOpen ? 'stats' : null;

  return (
    <div className={`${darkMode ? 'dark' : 'light'} flex flex-col h-screen w-screen overflow-hidden bg-background relative`}>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-3 focus:py-2 focus:rounded-md focus:bg-background focus:text-foreground focus:border focus:border-primary/50"
      >
        跳到主要内容
      </a>
      {/* TOP HEADER BAR */}
      <header className="app-header h-[60px] shrink-0 flex items-center px-5 z-30 relative">
        <div className="flex items-center gap-2.5 min-w-[200px]">
          <Network className="w-5 h-5 text-primary" style={{ filter: 'drop-shadow(0 0 6px color-mix(in srgb, var(--primary) 55%, transparent))' }} />
          <h1 className="text-sm font-semibold tracking-tight text-foreground text-balance" style={{ fontFamily: 'var(--font-display)', letterSpacing: '0.03em' }}>
            Cluster Intelligence
          </h1>
        </div>
        <div className="flex-1 flex justify-center px-8">
          <div className="relative w-full max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              aria-label="搜索 IP 地址"
              name="ip-search"
              type="search"
              autoComplete="off"
              placeholder="Search IP / Node ID..."
              className="w-full h-9 pl-9 pr-4 rounded-lg text-xs font-mono bg-muted/60 border border-border/70 focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:outline-none backdrop-blur-sm placeholder:text-muted-foreground/60 text-foreground transition-colors"
              value={headerSearchQuery}
              onChange={e => setHeaderSearchQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleHeaderSearch()}
            />
            {headerSearchQuery && (
              <button aria-label="清空搜索" className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setHeaderSearchQuery('')}>
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 min-w-[200px] justify-end">
          {data && (
            <div className="flex items-center gap-2 mr-2">
              <div className="w-2 h-2 rounded-full bg-emerald-400" style={{ boxShadow: '0 0 6px rgba(34,214,122,0.5)' }} />
              <span className="text-[10px] font-mono tabular-nums text-muted-foreground uppercase tracking-wider">{data.metadata.total_nodes} nodes</span>
            </div>
          )}
          {data && clusteringAppliedData && (
            <div className="flex items-center gap-2 mr-2" title={`当前分区方式：${clusteringStrategy === 'security_v3' ? '三层安全域' : '当前生效分区'}`}>
              <div className="w-2 h-2 rounded-full bg-primary" style={{ boxShadow: '0 0 6px rgba(14,165,233,0.5)' }} />
              <span className="text-[10px] font-mono tabular-nums text-muted-foreground uppercase tracking-wider">安全域 {clusteringAppliedData.metadata.communities}</span>
            </div>
          )}
          <div className="flex items-center gap-2 mr-2" title={darkMode ? '切换到亮色模式' : '切换到暗黑模式'}>
            <Sun className="w-3.5 h-3.5 text-muted-foreground" />
            <Switch checked={darkMode} onCheckedChange={setDarkMode} aria-label="主题切换" />
            <Moon className="w-3.5 h-3.5 text-muted-foreground" />
          </div>
          <button
            aria-label="打开设置"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary/30 transition-colors"
            onClick={() => setSettingsOpen(true)}
            title="设置"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* BODY */}
      <div className="flex flex-1 overflow-hidden relative">
        <div className="absolute inset-0 pointer-events-none z-0" style={{ background: 'radial-gradient(ellipse at 50% 0%, color-mix(in srgb, var(--primary) 5%, transparent) 0%, transparent 55%)' }} />

        {/* LEFT ICON TOOLBAR */}
        <aside className="icon-toolbar w-16 shrink-0 flex flex-col items-center pt-5 gap-1.5 z-20 relative">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button aria-label="数据源管理" className={`icon-toolbar-btn ${activeDrawer === 'datasource' ? 'active' : ''}`} onClick={() => setDataSourceOpen(p => !p)}>
                  <FolderOpen className="w-5 h-5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}><p>数据源管理</p></TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button aria-label="算法工具箱" className={`icon-toolbar-btn ${activeDrawer === 'algorithm' ? 'active' : ''}`} onClick={() => setAlgorithmOpen(p => !p)}>
                  <Puzzle className="w-5 h-5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}><p>算法切换</p></TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button aria-label="安全策略" className={`icon-toolbar-btn ${activeDrawer === 'security' ? 'active' : ''}`} onClick={() => setSecurityOpen(p => !p)}>
                  <Shield className="w-5 h-5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}><p>安全策略</p></TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button aria-label="统计面板" className={`icon-toolbar-btn ${activeDrawer === 'stats' ? 'active' : ''}`} onClick={() => setStatsOpen(p => !p)}>
                  <BarChart3 className="w-5 h-5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}><p>统计面板</p></TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </aside>

        {/* MAIN CANVAS */}
        <main id="main-content" className="flex-1 relative z-10">
          {data ? (
            <>
              <TopologyGraph
                key={resetKey}
                data={filteredData}
                edgeThreshold={edgeThreshold}
                nodeMinDegree={nodeMinDegree}
                selectedNode={selectedNode}
                highlightedCommunity={highlightedCommunity}
                searchNodeId={searchNodeId}
                showLabels={showLabels}
                onNodeSelect={handleNodeSelect}
                highlightPathNodeIds={pathNodeIds}
                highlightPathEdges={pathEdges}
                layoutPreset={layoutPreset}
                physics={graphPhysics}
                expansionNodes={expansionNodes}
                expansionEdges={expansionEdges}
                onExpandNeighbors={handleExpandNeighbors}
              />
              {focusedCommunity !== null && clusteringAppliedData && (() => {
                const domainNodeIds = new Set(clusteringAppliedData.nodes.filter(n => n.community === focusedCommunity).map(n => n.id));
                const neighborNodeCount = filteredData.nodes.length - domainNodeIds.size;
                const focusColor = communityColor(focusedCommunity);
                return (
                  <div className="absolute top-4 left-4 glass-panel stat-card-glow flex items-center gap-3 px-4 py-2.5 rounded-xl z-20" style={{ borderColor: `${focusColor}40` }}>
                    <div className="flex items-center gap-2">
                      <div className="relative">
                        <div className="w-3 h-3 rounded-full pulse-ring" style={{ backgroundColor: focusColor }} />
                        <div className="absolute inset-0 rounded-full blur-md opacity-60" style={{ backgroundColor: focusColor }} />
                      </div>
                      <span className="text-xs font-semibold text-foreground" style={{ fontFamily: 'var(--font-display)' }}>聚焦安全域 {focusedCommunity}</span>
                    </div>
                    <div className="h-4 w-px bg-border" />
                    <div className="flex items-center gap-3 text-[10px] font-mono">
                      <span className="text-muted-foreground">域内 <span className="text-foreground font-semibold">{domainNodeIds.size}</span> 节点</span>
                      {neighborNodeCount > 0 && <span className="text-muted-foreground">邻居 <span className="font-semibold" style={{ color: 'var(--warning)' }}>{neighborNodeCount}</span> 节点</span>}
                      <span className="text-muted-foreground"><span className="text-foreground font-semibold">{filteredData.links.length}</span> 连接</span>
                    </div>
                    <button className="ml-1 px-2.5 py-1 rounded-md text-[10px] font-medium text-muted-foreground hover:text-foreground bg-secondary/40 hover:bg-secondary/60 transition-colors border border-transparent hover:border-border/60" onClick={() => handleToggleFocus(null)}>取消聚焦</button>
                  </div>
                );
              })()}
            </>
          ) : (
            <div
              className={`topology-bg-enhanced flex items-center justify-center h-full relative transition-colors duration-300 ${isDragOver ? 'drag-over-active' : ''}`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <div className="text-center max-w-lg">
                <div className={`empty-state-border rounded-2xl p-10 mb-6 border-2 border-dashed transition-[border-color,transform] duration-300 ${isDragOver ? 'scale-[1.02]' : ''}`} style={{ borderColor: 'color-mix(in srgb, var(--primary) 18%, transparent)' }}>
                  <div className="animate-fade-in-up mb-5">
                    <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl" style={{ background: 'color-mix(in srgb, var(--primary) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--primary) 16%, transparent)' }}>
                      <svg className="w-8 h-8 text-primary float-slow" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0-5.25l4.5-4.5m0 0L12 3m-4.5 4.5L12 3m0 0l4.5 4.5M12 3v18m0-18l4.5 4.5M16.5 16.5L21 21m0 0l-4.5-4.5M21 21l-4.5 4.5" />
                      </svg>
                    </div>
                  </div>
                  <h2 className="animate-fade-in-up-d1 text-base font-semibold text-foreground mb-2" style={{ fontFamily: 'var(--font-display)' }}>数据导入</h2>
                  <p className="animate-fade-in-up-d2 text-xs text-muted-foreground mb-6 leading-relaxed">
                    支持上传 Excel (.xlsx) 或 JSON 格式的网络拓扑数据<br />系统将自动解析节点和连接关系并生成可视化图谱</p>
                  <div className="animate-fade-in-up-d3 flex items-center justify-center gap-3">
                    <label className="btn-glow inline-flex items-center gap-2 px-5 py-2.5 rounded-lg cursor-pointer text-xs font-medium" style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--primary) 22%, transparent), color-mix(in srgb, var(--primary) 6%, transparent))', border: '1px solid color-mix(in srgb, var(--primary) 32%, transparent)', color: 'var(--primary)' }}>
                      <Upload className="w-4 h-4" />
                      本地文件导入
                      <input ref={fileInputRef} type="file" accept=".json,.xlsx,.xls" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) await handleFileImport(f); e.target.value = ''; }} />
                    </label>
                    <button onClick={handleLoadFromNeo4j} disabled={loading} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed" style={{ background: 'var(--panel-bg-strong)', border: '1px solid color-mix(in srgb, var(--warning) 45%, transparent)', color: 'var(--warning)' }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--warning) 70%, transparent)'; e.currentTarget.style.boxShadow = '0 0 24px rgba(240,160,48,0.15)'; }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--warning) 45%, transparent)'; e.currentTarget.style.boxShadow = 'none'; }}
                    >
                      <Database className="w-4 h-4" />
                      {loading ? '加载中…' : '加载 Neo4j 数据'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>

        {/* INSPECTOR PANEL —?overlay on canvas, slides in when node selected */}
        {selectedNode && (
          <div className="inspector-slide-in absolute right-0 top-0 bottom-0 z-30">
            <InspectorPanel
              selectedNode={selectedNode}
              data={clusteringAppliedData}
              focusedCommunity={focusedCommunity}
              onNodeSelect={(node) => handleNodeSelect(node)}
              onToggleFocus={handleToggleFocus}
              gdsAlgorithm={gdsAlgorithm}
              gdsData={gdsData}
              onEnrichComplete={handleEnrichComplete}
            />
          </div>
        )}
      </div>

      {/* DRAWER: Data Source */}
      <Sheet open={dataSourceOpen} onOpenChange={setDataSourceOpen}>
        <SheetContent side="left" className="sm:max-w-none sheet-drawer-glass p-0 gap-0 overflow-hidden" style={{ width: drawerWidth }}>
          {/* 拖拽调整宽度 */}
          <div
            className="absolute top-0 bottom-0 right-0 z-20 w-1.5 cursor-col-resize bg-transparent hover:bg-primary/40 active:bg-primary/50 transition-colors"
            onPointerDown={startResize('left')}
            title="拖拽调整宽度"
          />
          <SheetHeader className="px-4 py-3 border-b border-border shrink-0">
            <SheetTitle className="text-sm font-mono flex items-center gap-2">
          <FolderOpen className="w-4 h-4 text-primary" /> 数据源管理</SheetTitle>
          </SheetHeader>
          <ScrollArea className="flex-1 min-h-0 px-4 py-4">
            <DataSourcePanel onImportData={handleImportData} onLoadFromNeo4j={handleLoadFromNeo4j} onLoadCoreGraph={handleLoadCoreGraph} loading={loading} data={clusteringAppliedData || data} />
          </ScrollArea>
        </SheetContent>
      </Sheet>

      {/* DRAWER: Algorithm Toolbox */}
      <Sheet open={algorithmOpen} onOpenChange={setAlgorithmOpen}>
        <SheetContent side="left" className="sm:max-w-none sheet-drawer-glass p-0 gap-0 overflow-hidden" style={{ width: drawerWidth }}>
          {/* 拖拽调整宽度 */}
          <div
            className="absolute top-0 bottom-0 right-0 z-20 w-1.5 cursor-col-resize bg-transparent hover:bg-primary/40 active:bg-primary/50 transition-colors"
            onPointerDown={startResize('left')}
            title="拖拽调整宽度"
          />
          <SheetHeader className="px-4 py-3 border-b border-border shrink-0">
            <SheetTitle className="text-sm font-mono flex items-center gap-2">
          <Puzzle className="w-4 h-4 text-violet-400" /> 算法工具箱</SheetTitle>
          </SheetHeader>
          <ScrollArea className="flex-1 min-h-0 px-4 py-4">
            <AlgorithmPanel
              data={clusteringAppliedData || data}
              originalCommunities={originalData ? new Set(originalData.nodes.map(n => n.community)).size : 0}
              gdsRunInfo={gdsRunInfo}
              gdsAlgorithm={gdsAlgorithm}
              onSwitchAlgorithm={handleSwitchDomainMode}
              gdsData={gdsData}
              runningGds={runningGds}
              onRunGDS={handleRunGDS}
              onGDSAnalysisComplete={refreshGdsData}
              clusteringStrategy={clusteringStrategy}
              onSwitchClustering={handleSwitchClustering}
              clusteringResult={clusteringResult}
              securityGranularity={securityGranularity}
              onSecurityGranularityChange={handleSecurityGranularityChange}
              securityEnrich={securityEnrich}
              onSecurityEnrichChange={handleSecurityEnrichChange}
            />
          </ScrollArea>
        </SheetContent>
      </Sheet>

      {/* DRAWER: Security Policy */}
      <Sheet open={securityOpen} onOpenChange={setSecurityOpen}>
        <SheetContent side="left" className="sm:max-w-none sheet-drawer-glass p-0 gap-0 overflow-hidden" style={{ width: drawerWidth }}>
          {/* 拖拽调整宽度 */}
          <div
            className="absolute top-0 bottom-0 right-0 z-20 w-1.5 cursor-col-resize bg-transparent hover:bg-primary/40 active:bg-primary/50 transition-colors"
            onPointerDown={startResize('left')}
            title="拖拽调整宽度"
          />
          <SheetHeader className="px-4 py-3 border-b border-border shrink-0">
            <SheetTitle className="text-sm font-mono flex items-center gap-2">
              <Shield className="w-4 h-4 text-amber-400" /> 安全策略
            </SheetTitle>
          </SheetHeader>
          <ScrollArea className="flex-1 min-h-0 px-4 py-4">
            <SecurityPanel data={clusteringAppliedData} baselineRules={baselineRules} onBaselineRulesChange={setBaselineRules} whitelist={whitelist} onAddToWhitelist={handleAddToWhitelist} onRemoveFromWhitelist={handleRemoveFromWhitelist} onNodeSelect={(node) => handleNodeSelect(node)} />
          </ScrollArea>
        </SheetContent>
      </Sheet>

      {/* DRAWER: Stats Panel */}
      <Sheet open={statsOpen} onOpenChange={setStatsOpen}>
        <SheetContent side="left" className="sm:max-w-none sheet-drawer-glass p-0 gap-0 overflow-hidden" style={{ width: drawerWidth }}>
          {/* 拖拽调整宽度 */}
          <div
            className="absolute top-0 bottom-0 right-0 z-20 w-1.5 cursor-col-resize bg-transparent hover:bg-primary/40 active:bg-primary/50 transition-colors"
            onPointerDown={startResize('left')}
            title="拖拽调整宽度"
          />
          <SheetHeader className="px-4 py-3 border-b border-border shrink-0">
            <SheetTitle className="text-sm font-mono flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-primary" /> 统计面板</SheetTitle>
          </SheetHeader>
          <ScrollArea className="flex-1 min-h-0 px-4 py-4">
            <StatsPanel data={clusteringAppliedData} onSearchNode={handleSearchNode} onHighlightCommunity={setHighlightedCommunity} focusedCommunity={focusedCommunity} onToggleFocus={handleToggleFocus} gdsAlgorithm={gdsAlgorithm} gdsRunInfo={gdsRunInfo} clusteringStrategy={clusteringStrategy} clusteringResult={clusteringResult} originalCommunities={originalData ? new Set(originalData.nodes.map(n => n.community)).size : 0} hubNodes={gdsData?.hubNodes || []} onQueryPath={handleQueryPath} onClearPath={handleClearPath} pathNodeIds={pathNodeIds} onExpandNeighbors={handleExpandNeighbors} onClearExpansion={handleClearExpansion} expansionNodeCount={expansionNodes.length} selectedNode={selectedNode} />
          </ScrollArea>
        </SheetContent>
      </Sheet>

      {/* DRAWER: Settings */}
      <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
        <SheetContent side="right" className="sm:max-w-none sheet-drawer-glass p-0 gap-0 overflow-hidden" style={{ width: settingsWidth }}>
          {/* 拖拽调整宽度 */}
          <div
            className="absolute top-0 bottom-0 left-0 z-20 w-1.5 cursor-col-resize bg-transparent hover:bg-primary/40 active:bg-primary/50 transition-colors"
            onPointerDown={startResize('right')}
            title="拖拽调整宽度"
          />
          <SheetHeader className="px-4 py-3 border-b border-border shrink-0">
            <SheetTitle className="text-sm font-mono flex items-center gap-2">
              <Settings className="w-4 h-4 text-primary" /> 设置
            </SheetTitle>
          </SheetHeader>
          <ScrollArea className="flex-1 min-h-0 px-4 py-4">
            <div className="space-y-5">
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-2">外观</div>
                <div className="flex items-center justify-between rounded-md bg-secondary/30 border border-border/50 px-3 py-2">
                  <div>
                    <div className="text-[11px] font-medium text-foreground">暗黑模式</div>
                    <div className="text-[11px] text-muted-foreground">深色界面与拓扑背景</div>
                  </div>
                  <Switch checked={darkMode} onCheckedChange={setDarkMode} />
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-2">图布局</div>
                <div className="grid grid-cols-3 gap-1.5 mb-3">
                  {[
                    { value: 'force' as GraphLayoutPreset, label: '力导向', icon: Network },
                    { value: 'radial' as GraphLayoutPreset, label: '径向', icon: Orbit },
                    { value: 'community' as GraphLayoutPreset, label: '安全域', icon: Layers },
                  ].map(opt => {
                    const Icon = opt.icon;
                    return (
                      <button
                        key={opt.value}
                        onClick={() => setLayoutPreset(opt.value)}
                        className={`h-9 rounded-md border text-[11px] font-medium flex flex-col items-center justify-center gap-1 transition-colors ${layoutPreset === opt.value
                          ? 'bg-primary/15 border-primary/40 text-primary'
                          : 'bg-secondary/30 border-border/50 text-muted-foreground hover:text-foreground'}`}
                      >
                        <Icon className="w-3.5 h-3.5" />
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                  <div>
                    <div className="flex items-baseline justify-between mb-1.5">
                      <span className="text-xs text-muted-foreground">边距距离</span>
                      <span className="text-xs font-mono text-foreground tabular-nums">{graphPhysics.linkDistance}</span>
                    </div>
                    <Slider value={[graphPhysics.linkDistance]} min={40} max={160} step={5} onValueChange={([v]) => setGraphPhysics(prev => ({ ...prev, linkDistance: v }))} className="py-1" />
                  </div>
                  <div>
                    <div className="flex items-baseline justify-between mb-1.5">
                      <span className="text-xs text-muted-foreground">斥力强度</span>
                      <span className="text-xs font-mono text-foreground tabular-nums">{Math.abs(graphPhysics.chargeStrength)}</span>
                    </div>
                    <Slider value={[Math.abs(graphPhysics.chargeStrength)]} min={50} max={800} step={10} onValueChange={([v]) => setGraphPhysics(prev => ({ ...prev, chargeStrength: -v }))} className="py-1" />
                  </div>
                  <div>
                    <div className="flex items-baseline justify-between mb-1.5">
                      <span className="text-xs text-muted-foreground">中心引力</span>
                      <span className="text-xs font-mono text-foreground tabular-nums">{graphPhysics.centerStrength.toFixed(2)}</span>
                    </div>
                    <Slider value={[graphPhysics.centerStrength]} min={0} max={1} step={0.05} onValueChange={([v]) => setGraphPhysics(prev => ({ ...prev, centerStrength: v }))} className="py-1" />
                  </div>
                  <div>
                    <div className="flex items-baseline justify-between mb-1.5">
                      <span className="text-xs text-muted-foreground">碰撞间距</span>
                      <span className="text-xs font-mono text-foreground tabular-nums">{graphPhysics.collideRadius}</span>
                    </div>
                    <Slider value={[graphPhysics.collideRadius]} min={0} max={16} step={1} onValueChange={([v]) => setGraphPhysics(prev => ({ ...prev, collideRadius: v }))} className="py-1" />
                  </div>
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-2">显示控制</div>
                <div>
                  <div className="flex items-baseline justify-between mb-1.5">
                    <span className="text-xs text-muted-foreground">边过滤</span>
                    <span className="text-xs font-mono text-foreground tabular-nums">{Math.round(edgeThreshold * 100)}%</span>
                  </div>
                  <Slider value={[edgeThreshold]} min={0} max={0.95} step={0.05} onValueChange={([v]) => setEdgeThreshold(v)} className="py-1" />
                </div>
                <div>
                  <div className="flex items-baseline justify-between mb-1.5">
                    <span className="text-xs text-muted-foreground">最小连接数</span>
                    <span className="text-xs font-mono text-foreground tabular-nums">{nodeMinDegree}</span>
                  </div>
                  <Slider value={[nodeMinDegree]} min={0} max={Math.min(Math.max(...(data?.nodes.map(n => n.degree || 0) ?? [0]), 0), 30)} step={1} onValueChange={([v]) => setNodeMinDegree(v)} className="py-1" />
                </div>
                <div className="flex items-center justify-between rounded-md bg-secondary/30 border border-border/50 px-3 py-2 mt-2">
                  <div>
                    <div className="text-[11px] font-medium text-foreground">节点标签</div>
                    <div className="text-[11px] text-muted-foreground">显示 IP 标签</div>
                  </div>
                  <Switch checked={showLabels} onCheckedChange={setShowLabels} />
                </div>
                <button
                  onClick={handleResetView}
                  className="mt-2 w-full h-8 rounded-md border text-[11px] font-medium flex items-center justify-center gap-1.5 bg-secondary/30 border-border/50 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  重置视图
                </button>
              </div>
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>

    </div>
  );
}
