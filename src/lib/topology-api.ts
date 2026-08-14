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
    service_type: string | null;
    geo_country: string | null;
    role_guess: string;
    business_group?: string | null;
    os_name?: string | null;
    application?: string | null;
    owner?: string | null;
    environment?: string | null;
    cmdb_tags?: string[];
  }>;
  links: Array<{
    source: string;
    target: string;
    weight: number;
    bytes: number;
    is_cross_domain: boolean;
  }>;
  zones: Array<{
    id: string;
    label: string;
    color: string;
    ips: number;
    subnets: number;
  }>;
}

let topologyCache: { data: Neo4jTopologyResponse; at: number } | null = null;
const TOPOLOGY_CACHE_TTL = 30_000;

export async function loadFromNeo4j(force = false): Promise<Neo4jTopologyResponse> {
  if (!force && topologyCache && Date.now() - topologyCache.at < TOPOLOGY_CACHE_TTL) {
    return topologyCache.data;
  }
  const response = await fetch('/api/topology/neo4j', { cache: 'no-store' });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Neo4j API 返回 ${response.status}: ${body}`);
  }
  const data = await response.json();
  topologyCache = { data, at: Date.now() };
  return data;
}

export async function getCommunityNodes(communityId: number) {
  const response = await fetch(`/api/nodes/${communityId}/neighbors`);
  return response.json();
}

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
  return response.json();
}
