import type { TopologyNode } from '@/lib/types';

export interface CmdbSimilarityWeights {
  businessGroup: number;
  application: number;
  os: number;
  environment: number;
  owner: number;
  cmdbTags: number;
}

export const DEFAULT_CMDB_WEIGHTS: CmdbSimilarityWeights = {
  businessGroup: 0.4,
  application: 0.25,
  os: 0.15,
  environment: 0.1,
  owner: 0.05,
  cmdbTags: 0.05,
};

export interface CmdbSimilarityLink {
  source: string;
  target: string;
  similarity: number;
}

const FIELD_MAP: Record<keyof CmdbSimilarityWeights, string> = {
  businessGroup: 'business_group',
  application: 'application',
  os: 'os_name',
  environment: 'environment',
  owner: 'owner',
  cmdbTags: 'cmdb_tags',
};

function valueSet(node: TopologyNode, field: keyof CmdbSimilarityWeights): Set<string> {
  const raw: unknown = (node as unknown as Record<string, unknown>)[FIELD_MAP[field]];
  if (Array.isArray(raw)) return new Set(raw.map(String).filter(Boolean));
  if (raw != null && raw !== '') return new Set([String(raw)]);
  return new Set();
}

function weightedJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const union = new Set([...a, ...b]);
  const inter = [...a].filter(x => b.has(x)).length;
  return inter / union.size;
}

export function nodeCmdbSimilarity(
  a: TopologyNode,
  b: TopologyNode,
  weights: CmdbSimilarityWeights = DEFAULT_CMDB_WEIGHTS
): number {
  let score = 0;
  const fields: Array<keyof CmdbSimilarityWeights> = [
    'businessGroup',
    'application',
    'os',
    'environment',
    'owner',
    'cmdbTags',
  ];
  for (const field of fields) {
    score += weights[field] * weightedJaccard(valueSet(a, field), valueSet(b, field));
  }
  return Math.round(score * 10000) / 10000;
}

export function topSimilarNodes(
  node: TopologyNode,
  nodes: TopologyNode[],
  weights: CmdbSimilarityWeights = DEFAULT_CMDB_WEIGHTS,
  k = 20
): Array<{ node: TopologyNode; similarity: number }> {
  return nodes
    .filter(n => n.id !== node.id)
    .map(n => ({ node: n, similarity: nodeCmdbSimilarity(node, n, weights) }))
    .sort((a, b) => b.similarity - a.similarity || a.node.id.localeCompare(b.node.id))
    .slice(0, k);
}

export function buildCmdbSimilarityGraph(
  nodes: TopologyNode[],
  threshold = 0.5,
  weights: CmdbSimilarityWeights = DEFAULT_CMDB_WEIGHTS,
  maxPerNode = 20
): CmdbSimilarityLink[] {
  const links: CmdbSimilarityLink[] = [];
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const groups = new Map<string, string[]>();
  const nodeGroups = new Map<string, Set<string>>();

  for (const node of nodes) {
    const keys = [node.business_group, node.application].filter(Boolean) as string[];
    nodeGroups.set(node.id, new Set(keys));
    for (const key of keys) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(node.id);
    }
  }

  const seen = new Set<string>();
  for (const node of nodes) {
    const keys = nodeGroups.get(node.id) || new Set<string>();
    if (keys.size === 0) continue;
    const candidates = new Set<string>();
    for (const key of keys) {
      for (const id of groups.get(key) || []) {
        if (id !== node.id) candidates.add(id);
      }
    }
    const scored = [...candidates]
      .map(id => ({ target: nodeById.get(id)!, similarity: nodeCmdbSimilarity(node, nodeById.get(id)!, weights) }))
      .sort((a, b) => b.similarity - a.similarity || a.target.id.localeCompare(b.target.id))
      .slice(0, maxPerNode);
    for (const entry of scored) {
      if (entry.similarity < threshold) continue;
      const key = [node.id, entry.target.id].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: node.id, target: entry.target.id, similarity: entry.similarity });
    }
  }

  return links;
}
