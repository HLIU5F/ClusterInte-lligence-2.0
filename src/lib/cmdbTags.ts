import type { TopologyNode } from '@/lib/types';

export interface CmdbTagEntry {
  key: string;
  label: string;
  value: string;
}

const CMDB_FIELDS = [
  { key: 'business_group', label: '业务组' },
  { key: 'application', label: '应用' },
  { key: 'os_name', label: '操作系统' },
  { key: 'owner', label: '负责人' },
  { key: 'environment', label: '环境' },
] as const;

export function getNodeCmdbTags(node: TopologyNode): CmdbTagEntry[] {
  const entries: CmdbTagEntry[] = [];
  for (const field of CMDB_FIELDS) {
    const value = (node as unknown as Record<string, unknown>)[field.key];
    if (value) entries.push({ key: field.key, label: field.label, value: String(value) });
  }
  for (const tag of node.cmdb_tags ?? []) {
    if (tag) entries.push({ key: 'tag', label: '标签', value: String(tag) });
  }
  return entries;
}
