// src/lib/localGds.ts
// 本地图算法降级：Neo4j/GDS 不可用时，直接用当前拓扑计算 WCC / Louvain，
// 保证 Louvain/WCC 按钮在本地也能产出新的 community 并刷新前端安全域数量。

import type { TopologyNode, TopologyLink } from '@/lib/types';
import { COMMUNITY_COLORS } from '@/lib/types';

export interface LocalGdsData {
  nodes: Array<{ ip: string; gds_louvain?: number; gds_wcc?: number }>;
  zones: Array<{
    algorithm: string;
    community: number;
    label: string;
    color: string;
    ip_count: number;
  }>;
  hubNodes: Array<{ ip: string; score: number }>;
}

function buildGraph(nodes: TopologyNode[], links: TopologyLink[]) {
  const ids = nodes.map(n => n.id);
  const index = new Map<string, number>(ids.map((id, i) => [id, i]));
  const adj: Array<Map<number, number>> = ids.map(() => new Map());
  for (const link of links) {
    const src = typeof link.source === 'object' ? link.source.id : link.source;
    const tgt = typeof link.target === 'object' ? link.target.id : link.target;
    const i = index.get(src);
    const j = index.get(tgt);
    if (i == null || j == null || i === j) continue;
    const w = Number(link.weight) || 1;
    adj[i].set(j, (adj[i].get(j) || 0) + w);
    adj[j].set(i, (adj[j].get(i) || 0) + w);
  }
  const degree = ids.map((_, i) => Array.from(adj[i].values()).reduce((a, b) => a + b, 0));
  const totalWeight = degree.reduce((a, b) => a + b, 0) / 2;
  return { ids, index, adj, degree, totalWeight };
}

export function computeWCC(nodes: TopologyNode[], links: TopologyLink[]): Map<string, number> {
  const { ids, adj } = buildGraph(nodes, links);
  const seen = new Uint8Array(ids.length);
  const result = new Map<string, number>();
  let component = 0;
  for (let i = 0; i < ids.length; i++) {
    if (seen[i]) continue;
    const stack = [i];
    seen[i] = 1;
    while (stack.length > 0) {
      const v = stack.pop()!;
      result.set(ids[v], component);
      for (const nb of adj[v].keys()) {
        if (!seen[nb]) { seen[nb] = 1; stack.push(nb); }
      }
    }
    component++;
  }
  return result;
}

function modularity(
  comm: number[],
  adj: Array<Map<number, number>>,
  degree: number[],
  m2: number,
  gamma: number
): number {
  const internal = new Map<number, number>();
  const totals = new Map<number, number>();
  for (let i = 0; i < comm.length; i++) {
    const c = comm[i];
    totals.set(c, (totals.get(c) || 0) + degree[i]);
    for (const [j, w] of adj[i]) {
      if (comm[i] === comm[j]) internal.set(c, (internal.get(c) || 0) + w);
    }
  }
  let q = 0;
  for (const [c, total] of totals) {
    q += (internal.get(c) || 0) / m2 - gamma * (total / m2) * (total / m2);
  }
  return q;
}

export function computeLouvain(
  nodes: TopologyNode[],
  links: TopologyLink[],
  gamma = 1.0
): Map<string, number> {
  const { ids, adj, degree, totalWeight } = buildGraph(nodes, links);
  const m2 = totalWeight * 2;
  if (m2 <= 0) return new Map(ids.map(id => [id, 0]));

  const comm = ids.map((_, i) => i);
  let q = modularity(comm, adj, degree, m2, gamma);

  for (let pass = 0; pass < 100; pass++) {
    let improved = false;
    const order = ids.map((_, i) => i).sort(() => Math.random() - 0.5);
    for (const i of order) {
      const candidates = new Set<number>([comm[i]]);
      for (const j of adj[i].keys()) candidates.add(comm[j]);
      let bestC = comm[i];
      let bestQ = q;
      for (const c of candidates) {
        const oldC = comm[i];
        if (c === oldC) continue;
        comm[i] = c;
        const nextQ = modularity(comm, adj, degree, m2, gamma);
        if (nextQ > bestQ + 1e-9) {
          bestQ = nextQ;
          bestC = c;
        }
        comm[i] = oldC;
      }
      if (bestC !== comm[i]) {
        comm[i] = bestC;
        q = bestQ;
        improved = true;
      }
    }
    if (!improved) break;
  }

  const labelMap = new Map<number, number>();
  const result = new Map<string, number>();
  let next = 0;
  for (let i = 0; i < ids.length; i++) {
    let label = labelMap.get(comm[i]);
    if (label == null) {
      label = next++;
      labelMap.set(comm[i], label);
    }
    result.set(ids[i], label);
  }
  return result;
}

/** 属性细分 key：网段 + 端口 + IP 尾号分块，保证同一图社区内还能进一步细分。 */
export interface AttrSubZoneOptions {
  subnet: boolean;
  ports: boolean;
  ipBlock: boolean;
}

export const DEFAULT_ATTR_SUBZONE_OPTIONS: AttrSubZoneOptions = {
  subnet: true,
  ports: true,
  ipBlock: true,
};

/** 属性细分 key：按设置组合网段 / 端口 / IP 尾号分块，保证同一图社区内还能进一步细分。 */
export function getAttrSubZoneKey(node: TopologyNode, options: AttrSubZoneOptions = DEFAULT_ATTR_SUBZONE_OPTIONS): string {
  const parts = node.id.split('.');
  const subnet = options.subnet && parts.length === 4 ? parts.slice(0, 3).join('.') : '';
  const ports = options.ports && Array.isArray(node.ports) && node.ports.length > 0
    ? [...new Set(node.ports)].sort((a, b) => a - b).join(',')
    : '';
  const lastOctet = options.ipBlock && parts.length === 4 ? Number(parts[3]) || 0 : 0;
  const block = options.ipBlock ? Math.floor(lastOctet / 4) * 4 : 0;
  return `${subnet}|${ports}|lb${block}`;
}

export function buildAttrSubZoneIndex(
  nodes: TopologyNode[],
  options: AttrSubZoneOptions = DEFAULT_ATTR_SUBZONE_OPTIONS
): (node: TopologyNode) => number {
  const keys = Array.from(new Set(nodes.map(node => getAttrSubZoneKey(node, options)))).sort();
  const indexMap = new Map(keys.map((k, i) => [k, i]));
  return (node) => indexMap.get(getAttrSubZoneKey(node, options)) ?? 0;
}

export function buildLocalGdsData(
  nodes: TopologyNode[],
  links: TopologyLink[],
  algorithm: 'louvain' | 'wcc'
): LocalGdsData {
  const communities = algorithm === 'wcc'
    ? computeWCC(nodes, links)
    : computeLouvain(nodes, links, 1.0);

  const nodeRows = nodes.map(n => {
    const community = communities.get(n.id) ?? 0;
    return algorithm === 'wcc'
      ? { ip: n.id, gds_wcc: community }
      : { ip: n.id, gds_louvain: community };
  });

  const byCommunity = new Map<number, number>();
  for (const c of communities.values()) byCommunity.set(c, (byCommunity.get(c) || 0) + 1);

  const zones = Array.from(byCommunity.entries())
    .map(([community, ip_count]) => ({
      algorithm,
      community,
      label: `${algorithm.toUpperCase()}-${community}`,
      color: COMMUNITY_COLORS[community % COMMUNITY_COLORS.length],
      ip_count,
    }))
    .sort((a, b) => b.ip_count - a.ip_count);

  return { nodes: nodeRows, zones, hubNodes: [] };
}
