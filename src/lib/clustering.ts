// src/lib/clustering.ts
// 多策略聚类：当图算法不适用时，基于节点属性进行安全域划分

import type { TopologyNode, TopologyLink } from '@/lib/types';

export type ClusteringStrategy =
  | 'subnet24'      // /24 子网分组
  | 'port_count'    // 端口数量分组
  | 'protocol'      // 协议类型分组
  | 'port_type'     // 端口类型分组（web/db/cache等）
  | 'ip_decade'     // IP 十位分组
  | 'service_type'  // 服务类型推断
  | 'zone_label'    // 按标签细分
  | 'security_v3';  // 三层安全域（核心基础设施域 + 物理域 + 业务社区 + 属性细分）

export type SecurityV3Granularity = 'standard' | 'finer' | 'ultrafine';

export const SECURITY_V3_GRANULARITY_LABELS: Record<SecurityV3Granularity, string> = {
  standard: '标准',
  finer: '更细',
  ultrafine: '极细',
};

export interface ClusteringZone {
  node_id: string;
  zone_id: string;
  algorithm: string;
}

export interface ClusteringResult {
  zones: ClusteringZone[];
  zoneCount: number;
  strategy: ClusteringStrategy;
  zoneLabels: Record<string, string>; // zone_id → 可读标签
  metrics?: {
    modularity: number;
    intraEdgePct: number;
    avgSize: number;
    singletons: number;
  };
}

export const CLUSTERING_LABELS: Record<ClusteringStrategy, string> = {
  subnet24: '/24 子网',
  port_count: '端口数量',
  protocol: '协议类型',
  port_type: '端口类型',
  ip_decade: 'IP 十位段',
  service_type: '服务类型',
  zone_label: '按 zone_label 细分',
  security_v3: '三层安全域',

};

export const CLUSTERING_DESCRIPTIONS: Record<ClusteringStrategy, string> = {
  subnet24: '按 C 类子网 (前3段) 分组，同一网段的 IP 归入同一安全域',
  port_count: '按节点涉及的端口数量分档（0 / 1-2 / 3-5 / 6-10 / 10+）',
  protocol: '按主要传输协议分组（TCP / UDP / 混合）',
  port_type: '按端口服务类型分组（Web / 数据库 / 缓存 / 消息队列等）',
  ip_decade: '按 IP 第三段十位数分组（如 10.0.10-19.x 为一组）',
  service_type: '按推断的服务角色分组（Web 服务 / 数据库 / 缓存等）',
  zone_label: '按 zone_label / zone_id 字符串分组（如 enrich、dmz 等），适合多域场景',
  security_v3: '先识别核心基础设施域，再按物理域 -> 业务通信社区 -> 属性细分的三层结构划分，并施加最小域规模约束',

};

// ============ 工具函数 ============

function getIpParts(ip: string): string[] {
  return ip.split('.');
}

function getSubnet24(ip: string): string {
  const parts = getIpParts(ip);
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}`;
  return ip;
}

function getIpDecade(ip: string): string {
  const parts = getIpParts(ip);
  if (parts.length === 4) {
    const third = parseInt(parts[2]) || 0;
    const decade = Math.floor(third / 10) * 10;
    return `${parts[0]}.${parts[1]}.${decade}-${decade + 9}`;
  }
  return ip;
}

/** 收集某节点在所有连接中涉及的端口 */
function getNodePorts(nodeId: string, links: any[]): Set<number> {
  const ports = new Set<number>();
  for (const link of links) {
    const src = typeof link.source === 'object' ? link.source.id : link.source;
    const tgt = typeof link.target === 'object' ? link.target.id : link.target;
    if (src === nodeId || tgt === nodeId) {
      const lp = (link as any).ports || [];
      for (const p of lp) ports.add(Number(p));
    }
  }
  return ports;
}

function binPortCount(count: number): string {
  if (count === 0) return '0端口';
  if (count <= 2) return '1-2端口';
  if (count <= 5) return '3-5端口';
  if (count <= 10) return '6-10端口';
  return '10+端口';
}

/** 端口号 → 服务类别 */
function classifyPort(port: number): string {
  if ([80, 443, 8080, 8443, 8000, 3000, 5000, 8888, 9090].includes(port)) return 'web';
  if ([3306, 5432, 1433, 1521, 27017, 6379, 9042, 7000].includes(port)) return 'database';
  if ([11211, 6379, 7000, 7001].includes(port)) return 'cache';
  if ([5672, 9092, 1883, 61616, 9093, 11211].includes(port)) return 'messaging';
  if ([25, 110, 143, 587, 993, 995].includes(port)) return 'email';
  if ([22, 23, 3389, 5900, 5901].includes(port)) return 'remote';
  if ([53, 853].includes(port)) return 'dns';
  if ([21, 20, 69, 115, 2049].includes(port)) return 'file_transfer';
  if ([88, 389, 636, 1812, 1813, 8649].includes(port)) return 'auth';
  if ([514, 6514, 9200, 9300, 8086, 5044].includes(port)) return 'logging';
  if ([161, 162, 9100, 9101, 9090].includes(port)) return 'monitoring';
  if (port < 1024) return 'system';
  return 'other';
}

const PORT_TYPE_LABELS: Record<string, string> = {
  web: 'Web服务',
  database: '数据库',
  cache: '缓存',
  messaging: '消息队列',
  email: '邮件',
  remote: '远程管理',
  dns: 'DNS',
  file_transfer: '文件传输',
  auth: '认证服务',
  logging: '日志采集',
  monitoring: '监控',
  system: '系统服务',
  other: '其他',
};

/** 从端口集合推断主要协议 */
function inferProtocol(ports: Set<number>): string {
  if (ports.size === 0) return 'tcp'; // 默认
  const udpPorts = new Set([53, 69, 123, 161, 162, 514, 1883, 5060, 5061, 69, 123, 161, 520, 521]);
  const hasUDP = [...ports].some(p => udpPorts.has(p));
  const tcpPorts = new Set([80, 443, 22, 3306, 5432, 8080, 25, 21, 23, 3389, 8443]);
  const hasTCP = [...ports].some(p => tcpPorts.has(p));
  if (hasTCP && hasUDP) return 'mixed';
  if (hasUDP) return 'udp';
  return 'tcp';
}

const PROTOCOL_LABELS: Record<string, string> = {
  tcp: 'TCP',
  udp: 'UDP',
  mixed: 'TCP+UDP',
};

// ============ 聚类策略实现 ============

function clusterBySubnet24(nodes: TopologyNode[]): ClusteringResult {
  const zones: ClusteringZone[] = [];
  const zoneLabels: Record<string, string> = {};

  for (const node of nodes) {
    const subnet = getSubnet24(node.id);
    const zoneId = `subnet_${subnet}`;
    zones.push({ node_id: node.id, zone_id: zoneId, algorithm: 'subnet24' });
    if (!zoneLabels[zoneId]) {
      zoneLabels[zoneId] = `${subnet}.0/24`;
    }
  }

  const uniqueZones = new Set(zones.map(z => z.zone_id));
  return { zones, zoneCount: uniqueZones.size, strategy: 'subnet24', zoneLabels };
}

function clusterByPortCount(nodes: TopologyNode[], links: any[]): ClusteringResult {
  const zones: ClusteringZone[] = [];
  const zoneLabels: Record<string, string> = {};

  for (const node of nodes) {
    const ports = getNodePorts(node.id, links);
    const bin = binPortCount(ports.size);
    const zoneId = `portcnt_${bin}`;
    zones.push({ node_id: node.id, zone_id: zoneId, algorithm: 'port_count' });
    if (!zoneLabels[zoneId]) {
      zoneLabels[zoneId] = bin;
    }
  }

  const uniqueZones = new Set(zones.map(z => z.zone_id));
  return { zones, zoneCount: uniqueZones.size, strategy: 'port_count', zoneLabels };
}

function clusterByProtocol(nodes: TopologyNode[], links: any[]): ClusteringResult {
  const zones: ClusteringZone[] = [];
  const zoneLabels: Record<string, string> = {};

  for (const node of nodes) {
    const ports = getNodePorts(node.id, links);
    const proto = inferProtocol(ports);
    const zoneId = `proto_${proto}`;
    zones.push({ node_id: node.id, zone_id: zoneId, algorithm: 'protocol' });
    if (!zoneLabels[zoneId]) {
      zoneLabels[zoneId] = PROTOCOL_LABELS[proto] || proto;
    }
  }

  const uniqueZones = new Set(zones.map(z => z.zone_id));
  return { zones, zoneCount: uniqueZones.size, strategy: 'protocol', zoneLabels };
}

function clusterByPortType(nodes: TopologyNode[], links: any[]): ClusteringResult {
  const zones: ClusteringZone[] = [];
  const zoneLabels: Record<string, string> = {};

  for (const node of nodes) {
    const ports = getNodePorts(node.id, links);
    // 统计每类端口的数量，取最多的作为该节点的类型
    const typeCounts: Record<string, number> = {};
    for (const p of ports) {
      const t = classifyPort(p);
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    }
    const dominantType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'other';
    const zoneId = `porttype_${dominantType}`;
    zones.push({ node_id: node.id, zone_id: zoneId, algorithm: 'port_type' });
    if (!zoneLabels[zoneId]) {
      zoneLabels[zoneId] = PORT_TYPE_LABELS[dominantType] || dominantType;
    }
  }

  const uniqueZones = new Set(zones.map(z => z.zone_id));
  return { zones, zoneCount: uniqueZones.size, strategy: 'port_type', zoneLabels };
}

function clusterByIpDecade(nodes: TopologyNode[]): ClusteringResult {
  const zones: ClusteringZone[] = [];
  const zoneLabels: Record<string, string> = {};

  for (const node of nodes) {
    const decade = getIpDecade(node.id);
    const zoneId = `decade_${decade}`;
    zones.push({ node_id: node.id, zone_id: zoneId, algorithm: 'ip_decade' });
    if (!zoneLabels[zoneId]) {
      zoneLabels[zoneId] = `${decade}.x`;
    }
  }

  const uniqueZones = new Set(zones.map(z => z.zone_id));
  return { zones, zoneCount: uniqueZones.size, strategy: 'ip_decade', zoneLabels };
}

function clusterByServiceType(nodes: TopologyNode[]): ClusteringResult {
  const zones: ClusteringZone[] = [];
  const zoneLabels: Record<string, string> = {};

  const ROLE_LABEL_MAP: Record<string, string> = {
    web_server: 'Web 服务',
    database: '数据库',
    cache: '缓存服务',
    message_queue: '消息队列',
    monitoring: '监控采集',
  };

  for (const node of nodes) {
    const svc = node.role_guess || node.service_type || 'unknown';
    const zoneId = `svc_${svc}`;
    zones.push({ node_id: node.id, zone_id: zoneId, algorithm: 'service_type' });
    if (!zoneLabels[zoneId]) {
      zoneLabels[zoneId] = ROLE_LABEL_MAP[svc] || svc;
    }
  }

  const uniqueZones = new Set(zones.map(z => z.zone_id));
  return { zones, zoneCount: uniqueZones.size, strategy: 'service_type', zoneLabels };
}

// ============ 主入口 ============


export function deriveZoneLabel(node: TopologyNode): string {
  const explicit = node.zone_label || node.zone_id;
  if (explicit && explicit !== 'default' && explicit !== 'Unassigned') return explicit;
  const ipParts = getIpParts(node.id);
  if (ipParts.length === 4) {
    const subnet = `${ipParts[0]}.${ipParts[1]}.${ipParts[2]}`;
    const ports = Array.isArray(node.ports) && node.ports.length > 0
      ? [...new Set(node.ports)].sort((a, b) => a - b).join(',')
      : '';
    return ports ? `${subnet}|${ports}` : subnet;
  }
  if (node.subnet_24) return node.subnet_24;
  const svc = node.service_type || node.role_guess || '';
  if (svc && svc !== '未知' && svc !== 'unknown' && svc !== 'Unassigned') return `svc:${svc}`;
  if (node.geo?.country) {
    const geoParts = [node.geo.country, node.geo.city, node.geo.isp].filter(Boolean);
    if (geoParts.length > 0) return `geo:${geoParts.join('/')}`;
  }
  return `anomaly:${node.anomaly_level || 'None'}`;
}

// ============ Zone Label clustering ============
function clusterByZoneLabel(nodes: TopologyNode[]): ClusteringResult {
  const zones: ClusteringZone[] = [];
  const zoneLabels: Record<string, string> = {};
  for (const node of nodes) {
    const label = deriveZoneLabel(node);
    const zoneId = `zonelabel_${label}`;
    zones.push({ node_id: node.id, zone_id: zoneId, algorithm: 'zone_label' });
    if (!zoneLabels[zoneId]) {
      zoneLabels[zoneId] = label;
    }
  }
  const uniqueZones = new Set(zones.map(z => z.zone_id));
  return { zones, zoneCount: uniqueZones.size, strategy: 'zone_label', zoneLabels };
}

// ============ 三层安全域划分 ============

const INFRA_PORTS = new Set([53, 123, 161, 162, 514, 6514, 9100, 9101, 9092, 9093, 2181, 9200, 9300, 8086, 5044, 5672, 1883, 61616, 36000, 18060, 22003]);
const BUSINESS_PORTS = new Set([80, 443, 8080, 8443, 8000, 3000, 5000, 8888, 9090, 3306, 5432, 1433, 1521, 27017, 6379, 11211, 22, 3389, 5900, 5901, 25, 110, 143, 587, 993, 995, 21, 20, 69, 2049, 389, 636]);

function classifyV3Port(port: number): 'infra' | 'business' | 'other' {
  if (INFRA_PORTS.has(port)) return 'infra';
  if (BUSINESS_PORTS.has(port)) return 'business';
  return 'other';
}

function isV3CoreInfraNode(node: TopologyNode, neighborCount: number, totalNodes: number): boolean {
  if (neighborCount >= Math.max(50, Math.ceil(totalNodes * 0.3))) return true;
  const ports = (node.ports || []).map(Number);
  const infraHits = ports.filter(p => classifyV3Port(p) === 'infra').length;
  return infraHits >= 2 && neighborCount >= Math.max(20, Math.ceil(totalNodes * 0.1));
}

function isV3BusinessEdge(link: any): boolean {
  const ports = (link as any).ports || [];
  if (ports.length === 0) return true;
  return ports.some((p: number) => classifyV3Port(Number(p)) !== 'infra');
}

function v3Louvain(nodeIds: string[], links: any[]): { comm: Map<string, number>; modularity: number } {
  const adj = new Map<string, Map<string, number>>();
  for (const id of nodeIds) adj.set(id, new Map());
  let m = 0;
  for (const link of links) {
    const s = typeof link.source === 'object' ? link.source.id : link.source;
    const t = typeof link.target === 'object' ? link.target.id : link.target;
    if (!adj.has(s) || !adj.has(t) || s === t) continue;
    const w = Number(link.weight) || 1;
    adj.get(s)!.set(t, (adj.get(s)!.get(t) || 0) + w);
    adj.get(t)!.set(s, (adj.get(t)!.get(s) || 0) + w);
    m += w;
  }
  m /= 2;
  const comm = new Map<string, number>();
  nodeIds.forEach((id, i) => comm.set(id, i));
  if (m === 0) return { comm, modularity: 0 };

  const deg = new Map<string, number>();
  for (const id of nodeIds) {
    deg.set(id, [...(adj.get(id) || new Map()).values()].reduce((a, b) => a + b, 0));
  }
  const tot = new Map<number, number>();
  const inner = new Map<number, number>();
  for (const id of nodeIds) {
    const c = comm.get(id)!;
    tot.set(c, (tot.get(c) || 0) + deg.get(id)!);
  }
  for (const id of nodeIds) {
    const c = comm.get(id)!;
    for (const [nbr, w] of adj.get(id) || new Map()) {
      if (comm.get(nbr) === c && id < nbr) inner.set(c, (inner.get(c) || 0) + w);
    }
  }

  const computeQ = () => {
    let q = 0;
    for (const c of new Set([...tot.keys(), ...inner.keys()])) {
      const lc = inner.get(c) || 0;
      const k = tot.get(c) || 0;
      q += lc / m - Math.pow(k / (2 * m), 2);
    }
    return q;
  };

  let moved = true;
  let pass = 0;
  while (moved && pass < 30) {
    moved = false;
    pass++;
    for (const id of nodeIds) {
      const c0 = comm.get(id)!;
      const wTo = new Map<number, number>();
      for (const [nbr, w] of adj.get(id) || new Map()) {
        const cn = comm.get(nbr)!;
        wTo.set(cn, (wTo.get(cn) || 0) + w);
      }
      let bestC = c0;
      let bestDq = 1e-9;
      for (const c of wTo.keys()) {
        if (c === c0) continue;
        const wInC = wTo.get(c) || 0;
        const wInOld = wTo.get(c0) || 0;
        const oldInnerC = inner.get(c) || 0;
        const oldInnerOld = inner.get(c0) || 0;
        const oldTotC = tot.get(c) || 0;
        const oldTotOld = tot.get(c0) || 0;
        const newInnerC = oldInnerC + wInC;
        const newTotC = oldTotC + deg.get(id)!;
        const newInnerOld = oldInnerOld - wInOld;
        const newTotOld = oldTotOld - deg.get(id)!;
        const dq = (newInnerC - oldInnerC) / m - (Math.pow(newTotC / (2 * m), 2) - Math.pow(oldTotC / (2 * m), 2))
          + (newInnerOld - oldInnerOld) / m - (Math.pow(newTotOld / (2 * m), 2) - Math.pow(oldTotOld / (2 * m), 2));
        if (dq > bestDq) { bestDq = dq; bestC = c; }
      }
      if (bestC !== c0) {
        inner.set(c0, (inner.get(c0) || 0) - (wTo.get(c0) || 0));
        tot.set(c0, (tot.get(c0) || 0) - deg.get(id)!);
        inner.set(bestC, (inner.get(bestC) || 0) + (wTo.get(bestC) || 0));
        tot.set(bestC, (tot.get(bestC) || 0) + deg.get(id)!);
        comm.set(id, bestC);
        moved = true;
      }
    }
  }

  const indexMap = new Map<number, number>();
  let idx = 0;
  const reindexed = new Map<string, number>();
  for (const id of nodeIds) {
    const c = comm.get(id)!;
    if (!indexMap.has(c)) indexMap.set(c, idx++);
    reindexed.set(id, indexMap.get(c)!);
  }
  return { comm: reindexed, modularity: computeQ() };
}

function v3DegreeTier(degree: number): string {
  if (degree >= 100) return 'hub';
  if (degree >= 10) return 'mid';
  return 'leaf';
}

interface V3CommProfile {
  neighborZones: string[];
  neighborSubnetCount: number;
}

function v3Signature(
  node: TopologyNode,
  ports: number[],
  includeZoneAttrs: boolean,
  enrichLabels: boolean,
  granularity: SecurityV3Granularity,
  comm?: V3CommProfile
): { key: string; label: string } {
  const svc = node.service_type && node.service_type !== '未知' && node.service_type !== 'unknown' ? node.service_type : '';
  const role = node.role_guess && node.role_guess !== '未知' && node.role_guess !== 'unknown' ? node.role_guess : '';
  const zoneAttr = includeZoneAttrs && !enrichLabels
    ? (node.zone_label && node.zone_label !== 'Unassigned' && node.zone_label !== 'default' ? node.zone_label
      : node.zone_id && node.zone_id !== 'Unassigned' && node.zone_id !== 'default' ? node.zone_id : '')
    : '';
  const enriched = enrichLabels ? deriveZoneLabel(node) : '';
  const ipParts = getIpParts(node.id);
  const subnet = getSubnet24(node.id);
  const fourth = parseInt(ipParts[3]) || 0;
  const subnet29 = ipParts.length === 4 ? `${subnet}.${Math.floor(fourth / 8) * 8}` : subnet;
  const classes = [...new Set(ports.map(p => classifyV3Port(p)))].sort();
  const sortedPorts = [...ports].sort((a, b) => a - b);
  const portKey = sortedPorts.length > 0 ? sortedPorts.join(',') : '';
  const portCountBucket = ports.length === 0 ? '0p' : ports.length <= 2 ? '1-2p' : ports.length <= 5 ? '3-5p' : '6+p';
  const inD = node.in_degree || 0;
  const outD = node.out_degree || 0;
  const direction = inD >= 3 && inD >= outD * 2 ? 'server' : outD >= 3 && outD >= inD * 2 ? 'client' : 'peer';
  const anyNode = node as any;
  const degreeTier = v3DegreeTier(node.degree || 0);
  const protocolKey = Array.isArray(node.protocols) && node.protocols.length
    ? [...new Set(node.protocols)].sort().join('+')
    : '';
  const anomalyKey = node.anomaly_level || '';
  const domainKey = anyNode.domain_source || '';
  const coreKey = anyNode.is_core_infra ? 'core' : '';
  const portCountKey = anyNode.port_count != null ? String(anyNode.port_count) : '';
  const businessTier = anyNode.business_degree != null ? v3DegreeTier(Number(anyNode.business_degree)) : '';
  const neighborZoneKey = comm?.neighborZones?.join('+') || '';
  const neighborSubnetKey = comm?.neighborSubnetCount ? `nsub${comm.neighborSubnetCount}` : '';
  const parts = [svc, role, zoneAttr, enriched, subnet29, direction, portKey, portCountBucket, classes.join('+')].filter(Boolean);
  const labelParts = [svc, role, zoneAttr, enriched, `${subnet29}/29`, direction, portKey ? `端口 ${portKey}` : '', portCountBucket, classes.join('+')].filter(Boolean);
  if (granularity === 'finer' || granularity === 'ultrafine') {
    const extra = [degreeTier, protocolKey, anomalyKey, domainKey, coreKey, neighborZoneKey].filter(Boolean);
    parts.push(...extra);
    labelParts.push(...extra);
  }
  if (granularity === 'ultrafine') {
    const extraFine = [portCountKey, businessTier, neighborSubnetKey, String(inD), String(outD)].filter(Boolean);
    parts.push(...extraFine);
    labelParts.push(...extraFine);
  }
  return {
    key: parts.join('|') || subnet,
    label: labelParts.join(' · ') || subnet,
  };
}

function v3Modularity(nodeZone: Map<string, string>, links: any[]): number {
  const deg = new Map<string, number>();
  for (const link of links) {
    const s = typeof link.source === 'object' ? link.source.id : link.source;
    const t = typeof link.target === 'object' ? link.target.id : link.target;
    if (s === t) continue;
    const w = Number(link.weight) || 1;
    deg.set(s, (deg.get(s) || 0) + w);
    deg.set(t, (deg.get(t) || 0) + w);
  }
  const m = [...deg.values()].reduce((a, b) => a + b, 0) / 2;
  if (m === 0) return 0;
  const tot = new Map<string, number>();
  const inner = new Map<string, number>();
  for (const [id, z] of nodeZone) tot.set(z, (tot.get(z) || 0) + (deg.get(id) || 0));
  for (const link of links) {
    const s = typeof link.source === 'object' ? link.source.id : link.source;
    const t = typeof link.target === 'object' ? link.target.id : link.target;
    if (s === t) continue;
    if (nodeZone.get(s) === nodeZone.get(t) && s < t) {
      const z = nodeZone.get(s)!;
      inner.set(z, (inner.get(z) || 0) + (Number(link.weight) || 1));
    }
  }
  let q = 0;
  for (const z of new Set([...tot.keys(), ...inner.keys()])) {
    q += (inner.get(z) || 0) / m - Math.pow((tot.get(z) || 0) / (2 * m), 2);
  }
  return q;
}

function clusterBySecurityV3(nodes: TopologyNode[], links: any[], granularity: SecurityV3Granularity = 'standard', enrichLabels = false): ClusteringResult {
  const MIN_GROUP_SIZE = 1;
  const L2_MODULARITY_THRESHOLD = granularity === 'standard' ? 0.3 : granularity === 'finer' ? 0.15 : 0;
  const includeZoneAttrs = granularity !== 'standard';

  const nodePorts = new Map<string, number[]>();
  const neighborCounts = new Map<string, number>();
  const nodesById = new Map(nodes.map(n => [n.id, n]));
  const commProfiles = new Map<string, V3CommProfile>();
  const portSets = new Map<string, Set<number>>();
  const neighborSets = new Map<string, Set<string>>();
  const neighborZoneSets = new Map<string, Set<string>>();
  const neighborSubnetSets = new Map<string, Set<string>>();
  for (const node of nodes) {
    portSets.set(node.id, new Set((node.ports || []).map(Number)));
    neighborSets.set(node.id, new Set());
    neighborZoneSets.set(node.id, new Set());
    neighborSubnetSets.set(node.id, new Set());
  }
  for (const link of links) {
    const s = typeof link.source === 'object' ? link.source.id : link.source;
    const t = typeof link.target === 'object' ? link.target.id : link.target;
    if (s === t) continue;
    neighborSets.get(s)?.add(t);
    neighborSets.get(t)?.add(s);
    for (const p of (link as any).ports || []) {
      const port = Number(p);
      portSets.get(s)?.add(port);
      portSets.get(t)?.add(port);
    }
    const srcNode = nodesById.get(s);
    const tgtNode = nodesById.get(t);
    if (srcNode) {
      const zone = srcNode.zone_id && srcNode.zone_id !== 'Unassigned' && srcNode.zone_id !== 'default' ? String(srcNode.zone_id) : '';
      if (zone) neighborZoneSets.get(t)?.add(zone);
      neighborSubnetSets.get(t)?.add(getSubnet24(s));
    }
    if (tgtNode) {
      const zone = tgtNode.zone_id && tgtNode.zone_id !== 'Unassigned' && tgtNode.zone_id !== 'default' ? String(tgtNode.zone_id) : '';
      if (zone) neighborZoneSets.get(s)?.add(zone);
      neighborSubnetSets.get(s)?.add(getSubnet24(t));
    }
  }
  for (const node of nodes) {
    nodePorts.set(node.id, [...(portSets.get(node.id) || new Set())]);
    neighborCounts.set(node.id, neighborSets.get(node.id)?.size || 0);
    commProfiles.set(node.id, {
      neighborZones: [...(neighborZoneSets.get(node.id) || new Set())].sort(),
      neighborSubnetCount: neighborSubnetSets.get(node.id)?.size || 0,
    });
  }

  const coreInfraIds = new Set<string>();
  for (const node of nodes) {
    if (isV3CoreInfraNode(node, neighborCounts.get(node.id) || 0, nodes.length)) coreInfraIds.add(node.id);
  }

  // L1: physical / subnet base domains
  const l1Base = new Map<string, string>();
  const baseNames = new Map<string, string>();
  const coreBase = 'core_infra';
  baseNames.set(coreBase, '核心基础设施域');
  for (const node of nodes) {
    if (coreInfraIds.has(node.id)) {
      l1Base.set(node.id, coreBase);
      continue;
    }
    const zone = node.zone_id && node.zone_id !== 'Unassigned' && node.zone_id !== 'default' ? node.zone_id : '';
    const subnet = getSubnet24(node.id);
    const base = zone ? `zone_${zone}` : `subnet_${subnet}`;
    l1Base.set(node.id, base);
    if (!baseNames.has(base)) baseNames.set(base, zone ? `Zone ${zone}` : `${subnet}.0/24`);
  }

  // L2: business-edge Louvain inside each base domain
  const l2Zone = new Map<string, string>();
  const zoneNames = new Map<string, string>();
  const l1Groups = new Map<string, string[]>();
  for (const node of nodes) {
    const base = l1Base.get(node.id)!;
    if (!l1Groups.has(base)) l1Groups.set(base, []);
    l1Groups.get(base)!.push(node.id);
  }

  for (const [baseId, memberIds] of l1Groups) {
    const members = new Set(memberIds);
    const businessLinks = links.filter(l => {
      const s = typeof l.source === 'object' ? l.source.id : l.source;
      const t = typeof l.target === 'object' ? l.target.id : l.target;
      return members.has(s) && members.has(t) && isV3BusinessEdge(l);
    });
    if (businessLinks.length === 0) {
      for (const id of memberIds) l2Zone.set(id, baseId);
      zoneNames.set(baseId, baseNames.get(baseId)!);
      continue;
    }
    const { comm, modularity } = v3Louvain(memberIds, businessLinks);
    const commGroups = new Map<number, string[]>();
    for (const id of memberIds) {
      const c = comm.get(id)!;
      if (!commGroups.has(c)) commGroups.set(c, []);
      commGroups.get(c)!.push(id);
    }
    if (modularity >= L2_MODULARITY_THRESHOLD && commGroups.size > 1) {
      let subIdx = 1;
      for (const group of commGroups.values()) {
        if (group.length < MIN_GROUP_SIZE) {
          for (const id of group) {
            l2Zone.set(id, baseId);
            zoneNames.set(baseId, baseNames.get(baseId)!);
          }
          continue;
        }
        const zoneId = `${baseId}/s${subIdx++}`;
        for (const id of group) l2Zone.set(id, zoneId);
        zoneNames.set(zoneId, `${baseNames.get(baseId)!} · 子域 ${subIdx - 1}`);
      }
    } else {
      for (const id of memberIds) l2Zone.set(id, baseId);
      zoneNames.set(baseId, baseNames.get(baseId)!);
    }
  }

  // L3: attribute subdivision with minimum group size; tiny groups merge back to parent
  const l3Groups = new Map<string, string[]>();
  const l3Names = new Map<string, string>();
  const l2Groups = new Map<string, string[]>();
  for (const node of nodes) {
    const z = l2Zone.get(node.id)!;
    if (!l2Groups.has(z)) l2Groups.set(z, []);
    l2Groups.get(z)!.push(node.id);
  }
  for (const [l2Id, memberIds] of l2Groups) {
    const sigGroups = new Map<string, string[]>();
    const sigLabels = new Map<string, string>();
    for (const id of memberIds) {
      const node = nodesById.get(id)!;
      const sig = v3Signature(node, nodePorts.get(id) || [], includeZoneAttrs, enrichLabels, granularity, commProfiles.get(id));
      if (!sigGroups.has(sig.key)) sigGroups.set(sig.key, []);
      sigGroups.get(sig.key)!.push(id);
      if (!sigLabels.has(sig.key)) sigLabels.set(sig.key, sig.label);
    }
    let attrIdx = 1;
    for (const [key, group] of sigGroups) {
      if (group.length < MIN_GROUP_SIZE) {
        for (const id of group) l3Groups.set(id, [l2Id]);
        continue;
      }
      const zoneId = `${l2Id}/a${attrIdx++}`;
      for (const id of group) l3Groups.set(id, [zoneId]);
      l3Names.set(zoneId, `${zoneNames.get(l2Id) || l2Id} · ${sigLabels.get(key)}`);
    }
  }

  // Final sequential zone ids
  const zoneOrder: string[] = [];
  const nodeZone = new Map<string, string>();
  for (const node of nodes) {
    const candidates = l3Groups.get(node.id) || [l2Zone.get(node.id)!];
    const zoneId = candidates[0];
    nodeZone.set(node.id, zoneId);
    if (!zoneOrder.includes(zoneId)) zoneOrder.push(zoneId);
  }

  const zones: ClusteringZone[] = [];
  const zoneLabels: Record<string, string> = {};
  nodeZone.forEach((zoneId, nodeId) => {
    zones.push({ node_id: nodeId, zone_id: zoneId, algorithm: 'security_v3' });
    zoneLabels[zoneId] = l3Names.get(zoneId) || zoneNames.get(zoneId) || zoneId;
  });

  const zoneSizes = new Map<string, number>();
  for (const id of nodeZone.values()) zoneSizes.set(id, (zoneSizes.get(id) || 0) + 1);
  const sizes = [...zoneSizes.values()].sort((a, b) => b - a);
  let intraW = 0;
  let totalW = 0;
  for (const link of links) {
    const s = typeof link.source === 'object' ? link.source.id : link.source;
    const t = typeof link.target === 'object' ? link.target.id : link.target;
    const w = Number(link.weight) || 1;
    if (s === t) continue;
    totalW += w;
    if (nodeZone.get(s) === nodeZone.get(t)) intraW += w;
  }
  const metrics = {
    modularity: Number(v3Modularity(nodeZone, links).toFixed(4)),
    intraEdgePct: totalW > 0 ? Number(((intraW / totalW) * 100).toFixed(1)) : 0,
    avgSize: sizes.length > 0 ? Number((nodes.length / sizes.length).toFixed(2)) : 0,
    singletons: sizes.filter(s => s === 1).length,
  };

  return {
    zones,
    zoneCount: zoneOrder.length,
    strategy: 'security_v3',
    zoneLabels,
    metrics,
  };
}

export function computeClustering(
  nodes: TopologyNode[],
  links: any[],
  strategy: ClusteringStrategy,
  granularity: SecurityV3Granularity = 'standard',
  enrichLabels = false
): ClusteringResult {
  switch (strategy) {
    case 'subnet24':
      return clusterBySubnet24(nodes);
    case 'port_count':
      return clusterByPortCount(nodes, links);
    case 'protocol':
      return clusterByProtocol(nodes, links);
    case 'port_type':
      return clusterByPortType(nodes, links);
    case 'ip_decade':
      return clusterByIpDecade(nodes);
    case 'service_type':
      return clusterByServiceType(nodes);
    case 'zone_label':
      return clusterByZoneLabel(nodes);
    case 'security_v3':
      return clusterBySecurityV3(nodes, links, granularity, enrichLabels);
    default:
      return clusterBySubnet24(nodes);
  }
}

