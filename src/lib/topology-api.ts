// src/lib/topology-api.ts
//
// Cluster-Intelligence 拓扑数据接口
//
// 历史上曾调用 http://localhost:8000/api/topology（幽灵服务），
// 现统一改成走 Next.js 自己的 Route Handler，同源 / 简单 / 不再依赖外部 server。

export interface Neo4jTopologyResponse {
  metadata: {
    generated_at: string;
    source: string;
    total_nodes: number;
    total_links: number;
    communities: number;
    /** 是否因为节点上限被截断（服务端按连通度降序保留前 N 个） */
    truncated?: boolean;
    /** 截断前库里的 IP 总数 */
    total_ips_in_db?: number;
    /** 生效的节点上限；null = 未限制（?all=1） */
    node_limit?: number | null;
  };
  nodes: Array<{
    id: string;
    community: number;
    subnet_24: string;
    zone_id: string;
    zone_color: string;
    zone_label: string;
    degree: number;
    in_degree: number;
    out_degree: number;
    anomaly_score: number;
    is_anomaly: boolean;
    anomaly_level: 'Critical' | 'High' | 'Medium' | 'Low' | 'None';
    is_hub: boolean;
    is_critical?: boolean;
    service_type: string | null;
    geo_country: string | null;
    role_guess: string;
    business_group?: string | null;
    os_name?: string | null;
    application?: string | null;
    owner?: string | null;
    environment?: string | null;
    cmdb_tags?: string[];
    // IP 节点的端口/协议签名（列表），端口服务域/策略域聚类依赖
    ports?: number[];
    protocols?: string[];
  }>;
  links: Array<{
    source: string;
    target: string;
    weight: number;
    bytes: number;
    is_cross_domain: boolean;
    // CONNECTS_TO 关系的端口/协议签名（列表）
    ports?: number[];
    protocols?: string[];
  }>;
  zones: Array<{
    id: string;
    label: string;
    color: string;
    ips: number;
    subnets: number;
  }>;
}

/** 后端统一错误体（与 src/lib/apiErrors.ts 的形状一一对应） */
interface ApiErrorBody {
  error?: string;
  code?: string;
  detail?: string;
  hint?: string;
}

/** 带机器可读 code 的前端 API 错误：UI 据此区分「连不上库」与「查询失败」并决定降级 */
export class ApiError extends Error {
  readonly code: string;
  readonly hint: string;
  readonly status: number;

  constructor(message: string, opts: { code?: string; hint?: string; status?: number } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = opts.code ?? 'UNKNOWN';
    this.hint = opts.hint ?? '';
    this.status = opts.status ?? 0;
  }
}

/** 把任意异常整理成可直接展示的 { message, hint, code } */
export function describeApiError(err: unknown): { message: string; hint: string; code: string } {
  if (err instanceof ApiError) {
    return { message: err.message, hint: err.hint, code: err.code };
  }
  return {
    message: err instanceof Error ? err.message : String(err),
    hint: '',
    code: 'UNKNOWN',
  };
}

export interface CoreDatasetOption {
  file: string;
  label: string;
}

/**
 * 数据源面板可选的静态数据集（对应 public/ 下的文件）。
 *
 * 只有 topology_demo.json 进了 git；其余都是真实网络数据，已被 .gitignore 排除，
 * 服务器上需要 `bash scripts/server_migrate.sh prepare` 回填后才存在。
 * 选中不存在的文件时前端会明确报出 HTTP 404，并自动回退到演示数据。
 */
export const CORE_DATASETS: CoreDatasetOption[] = [
  { file: '/topology_data_core.json', label: '业务核心图 · 212 节点 · 星型采集流量（默认，快）' },
  { file: '/topology_demo.json', label: '合成演示 · RFC 5737（仓库自带，快）' },
  { file: '/topology_data_security_enhanced.json', label: '安全增强 v4 · 3736 节点 · 资产台账（渲染慢）' },
  { file: '/topology_data_security.json', label: '安全增强 v3 · 3736 节点 · 资产台账（渲染慢）' },
  { file: '/topology_for_frontend_new2.0.json', label: '新基线关系图 new2.0 · 3358 节点 / 23741 边 · 6 安全域（推荐图分析）' },
  { file: '/topology_for_frontend.json', label: '主机间访问图 · 3739 节点 / 8893 边 · 适合图分析（渲染慢）' },
  { file: '/topology_data_purified.json', label: '净化全量 · 3736 节点 · 资产台账（渲染慢）' },
];

/** 「加载业务核心图」的默认回退链：只放体量可控的数据集，避免一次渲染数千孤立节点 */
export const CORE_DATASET_CHAIN: readonly string[] = [
  '/topology_data_core.json',
  '/topology_demo.json',
];

/** 缓存按查询串区分，否则「截断版」和「全量版」会互相串味 */
let topologyCache: { key: string; data: Neo4jTopologyResponse; at: number } | null = null;
const TOPOLOGY_CACHE_TTL = 30_000;

export interface LoadFromNeo4jOptions {
  /** 只取前 N 个节点（服务端按连通度降序保留） */
  limit?: number;
  /** 关闭服务端节点上限，拉全量（数千节点时浏览器可能卡顿） */
  all?: boolean;
}

export async function loadFromNeo4j(
  force = false,
  opts: LoadFromNeo4jOptions = {}
): Promise<Neo4jTopologyResponse> {
  const params = new URLSearchParams();
  if (opts.all) params.set('all', '1');
  else if (opts.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  const cacheKey = qs || 'default';

  if (
    !force &&
    topologyCache &&
    topologyCache.key === cacheKey &&
    Date.now() - topologyCache.at < TOPOLOGY_CACHE_TTL
  ) {
    return topologyCache.data;
  }
  const response = await fetch(`/api/topology/neo4j${qs ? `?${qs}` : ''}`, { cache: 'no-store' });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(
      body?.detail || body?.error || `Neo4j API 返回 ${response.status}`,
      { code: body?.code ?? 'NEO4J_UNKNOWN', hint: body?.hint ?? '', status: response.status }
    );
  }
  const data = await response.json();
  topologyCache = { key: cacheKey, data, at: Date.now() };
  return data;
}

// 注：此前的 getCommunityNodes() 指向 /api/nodes/{id}/neighbors —— 该路由从未实现（必然 404），
// 且无任何调用方；如需按域取邻居请走 /api/analysis/neighbors。已删除以免误用。

export async function getAnomalies(threshold: number = 0.8) {
  // 当前未实现专门的 anomalies 路由，暂时从 topology 主接口筛
  const r = await loadFromNeo4j();
  return { anomalies: r.nodes.filter(n => n.anomaly_score >= threshold) };
}

export async function getZones() {
  const r = await loadFromNeo4j();
  return r.zones;
}

// ============== GDS 动态分区 ===============

export type GDSAlgorithm = 'louvain' | 'wcc' | 'pagerank' | 'all';

export interface GDSRunResponse {
  success: boolean;
  graph?: { nodeCount: number; relationshipCount: number };
  maxLevels?: number;
  louvain?: {
    count: number;
    communities: number;
    sample: Array<{ ip: string; community: number }>;
    persisted?: { zones: number; members: number };
  };
  wcc?: {
    count: number;
    components: number;
    sample: Array<{ ip: string; component: number }>;
    persisted?: { zones: number; members: number };
  };
  pagerank?: {
    count: number;
    top: Array<{ ip: string; score: number }>;
    persisted?: number;
  };
  error?: string;
}

export interface GDSZoneDetail {
  algorithm: string;
  community: number;
  label: string;
  color: string;
  ip_count: number;
}

/**
 * 触发一次 GDS 分析。可选算法；默认全跑、默认持久化。
 *
 * persist=true 时，算法结果会落到：
 *   - (:IP {gds_<algo>})
 *   - (:GDSZone {algorithm, community, color, label, ip_count})
 *   - (:IP)-[:IN_GDS_ZONE]->(:GDSZone)
 * persist=false 时只跑不写，用于纯探索性跑。
 *
 * maxLevels 控制 Louvain 社区划分层级（值越小社区越多）：
 *   1-2 = 细粒度（大量小社区）
 *   3-5 = 中等
 *   8-10 = 粗粒度（少量大社区）
 */
export async function runGDSAnalysis(
  algorithm: GDSAlgorithm = 'all',
  persist: boolean = true,
  maxLevels: number = 2
): Promise<GDSRunResponse> {
  const response = await fetch('/api/analysis/gds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ algorithm, persist, maxLevels }),
  });
  return response.json();
}

/** 读取已持久化的 GDS 区汇总 + 每域详情 + PageRank Top10 */
export async function getGDSStatus(): Promise<{
  zones: Array<{ algorithm: string; zone_count: number; total_ips: number }>;
  topPageRank: Array<{ ip: string; score: number }>;
  zoneDetails: GDSZoneDetail[];
}> {
  const response = await fetch('/api/analysis/gds', { cache: 'no-store' });
  const data = (await response.json().catch(() => null)) as
    | (ApiErrorBody & {
        success?: boolean;
        zones?: Array<{ algorithm: string; zone_count: number; total_ips: number }>;
        topPageRank?: Array<{ ip: string; score: number }>;
        zoneDetails?: GDSZoneDetail[];
      })
    | null;
  if (!response.ok) {
    throw new ApiError(
      data?.detail || data?.error || `GDS 状态加载失败（HTTP ${response.status}）`,
      { code: data?.code ?? 'NEO4J_UNKNOWN', hint: data?.hint ?? '', status: response.status }
    );
  }
  if (data?.success === false) {
    throw new ApiError(data.error || 'GDS 状态加载失败', {
      code: data.code ?? 'NEO4J_UNKNOWN',
      hint: data.hint ?? '',
      status: response.status,
    });
  }
  return {
    zones: data?.zones ?? [],
    topPageRank: data?.topPageRank ?? [],
    zoneDetails: data?.zoneDetails ?? [],
  };
}
