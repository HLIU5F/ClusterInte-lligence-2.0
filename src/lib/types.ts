export interface TopologyNode {
  id: string;
  community: number;
  degree: number;
  in_degree: number;
  out_degree: number;
  bytes_sent: number;
  bytes_received: number;
  is_anomaly: boolean;
  anomaly_score: number;
  anomaly_level: 'Critical' | 'High' | 'Medium' | 'Low' | 'None';
  role_guess: string;
  is_whitelisted?: boolean;
  whitelist_reason?: string;
  isFocusedDomain?: boolean;
  isCrossDomain?: boolean;
  // D3 simulation properties
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
    // 丰富器字段
  service_type?: string;
  service_confidence?: number;
  geo?: {
    country: string;
    city: string;
    isp: string;
  };
  // GDS 算法持久化字段
  gds_louvain?: number;
  gds_wcc?: number;
  gds_pagerank?: number;
  subnet_24?: string;
  zone_id?: string;
  zone_color?: string;
  zone_label?: string;
  ports?: number[];
  protocols?: string[];
  is_hub?: boolean;
  /** 关键资产（DNS/DB/缓存/MQ 等）：正常功能不是异常，仅打"重要"标签 */
  is_critical?: boolean;
  business_group?: string;
  os_name?: string;
  application?: string;
  owner?: string;
  environment?: string;
  cmdb_tags?: string[];
}

export interface RawLog {
  proto: string;
  src: string;
  dst: string;
  dport: number;
  deviceDirection: string;
  cdate: string;
  sdate: string;
}

export interface TopologyLink {
  source: string | TopologyNode;
  target: string | TopologyNode;
  weight: number;
  bytes: number;
  // Neo4j CONNECTS_TO 关系属性：ports/protocols 都是列表（number[] / string[]），
  // 用于端口服务域 / 策略域聚类，来自 Neo4j 加载或净化数据。
  ports?: number[];
  protocols?: string[];
}

export interface TopologyMetadata {
  generated_at: string;
  source: string;
  total_nodes: number;
  total_links: number;
  communities: number;
  modularity?: number;
  resolution_used?: number;
  min_community_size?: number;
}

export interface TopologyData {
  metadata: TopologyMetadata;
  nodes: TopologyNode[];
  links: TopologyLink[];
  domainNames?: Record<number, string>;
}

export interface SecurityDomain {
  id: number;
  name: string;
  description: string;
  color: string;
  nodeCount: number;
  linkCount: number;
  avgAnomalyScore: number;
  totalBytes: number;
}

export interface BaselineRule {
  id: string;
  name: string;
  description: string;
  field: 'anomaly_score' | 'bytes_sent' | 'bytes_received' | 'degree' | 'port_entropy';
  operator: 'gt' | 'lt' | 'eq' | 'between';
  threshold: number;
  thresholdMax?: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  enabled: boolean;
}

export interface BaselineViolation {
  rule: BaselineRule;
  nodeId: string;
  actualValue: number;
}

// 白名单/抑制规则
export interface WhitelistRule {
  id: string;
  nodeId: string;           // 节点 ID（IP 地址）
  reason: string;           // 白名单原因
  addedAt: string;          // 添加时间
  addedBy?: string;         // 添加人
}

export interface NetworkStats {
  totalNodes: number;
  totalLinks: number;
  totalCommunities: number;
  anomalyCount: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  totalTraffic: number;
  avgDegree: number;
  maxDegree: number;
}

export const COMMUNITY_COLORS: string[] = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899',
  '#06b6d4', '#f97316', '#84cc16', '#6366f1', '#14b8a6', '#e11d48',
  '#a855f7', '#0ea5e9', '#d946ef', '#22d3ee', '#fbbf24', '#34d399',
  '#fb923c', '#c084fc', '#f472b6', '#a3e635',
  '#2dd4bf', '#f43f5e', '#818cf8', '#facc15', '#4ade80',
  '#e879f9', '#38bdf8', '#fb7185', '#a78bfa', '#34d399',
  '#fbbf24', '#c084fc', '#22d3ee', '#f87171', '#a3e635',
  '#f472b6', '#67e8f9', '#fca5a5', '#86efac', '#fde047',
  '#d8b4fe', '#7dd3fc', '#fda4af', '#bef264', '#e9d5ff',
  '#bae6fd', '#fecdd3', '#d9f99d', '#c4b5fd', '#99f6e4',
  '#fbcfe8', '#a5f3fc', '#fed7aa', '#bbf7d0', '#fecaca',
  '#e0e7ff', '#ccfbf1', '#fef08a', '#cffafe', '#fce7f3',
  '#d1fae5',
];

/** HSL → hex（供金黄角色板使用） */
function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const color = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

const _communityColorCache = new Map<number, string>();

/**
 * 高区分度安全域色：金黄角（137.508°）HSL 步进，任意数量安全域都不撞色。
 * 取代 12 色循环 `COMMUNITY_COLORS[community % 12]`——真实数据 59 个域时循环必然撞色。
 */
export function communityColor(community: number): string {
  const cached = _communityColorCache.get(community);
  if (cached) return cached;
  const hue = (community * 137.508) % 360;
  const sat = 62 + (community % 3) * 9; // 62 / 71 / 80
  const light = 56 + (community % 2) * 7; // 56 / 63（深色背景上保持可读）
  const color = hslToHex(hue, sat, light);
  _communityColorCache.set(community, color);
  return color;
}

export const ROLE_LABELS: Record<string, string> = {
  web_server: 'Web 服务',
  database: '数据库',
  cache: '缓存服务',
  message_queue: '消息队列',
  monitoring: '监控采集',
  load_balancer: '负载均衡',
  api_gateway: 'API 网关',
  file_server: '文件服务',
  dns_server: 'DNS 服务',
  mail_server: '邮件服务',
  bastion_host: '跳板机/管理服务器',
  admin_server: '管理服务器',
  ldap_server: 'LDAP 服务',
  rpc_service: 'RPC/NFS 服务',
  data_platform: '数据平台/日志基础设施',
  unknown: '未知角色',
};

export const ANOMALY_LEVEL_COLORS: Record<string, string> = {
  Critical: '#ef4444',
  High: '#f97316',
  Medium: '#f59e0b',
  Low: '#10b981',
};

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(bytes / Math.pow(k, i));
  return `${value} ${sizes[i]}`;
}

export function formatNumber(num: number): string {
  if (num >= 1000000) {
    return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(num / 1000000)}M`;
  }
  if (num >= 1000) {
    return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(num / 1000)}K`;
  }
  return num.toString();
}

export function getAnomalyLevel(score: number): TopologyNode['anomaly_level'] {
  if (score > 0.75) return 'Critical';
  if (score > 0.60) return 'High';
  if (score > 0.45) return 'Medium';
  return 'Low';
}
// GDS 枢纽节点
export interface GDSHubNode {
  ip: string;
  score: number;
}

// GDS 运行溯源：记录算法来源、基域数量、降级原因和质量指标
export interface GdsRunInfo {
  algorithm: 'louvain' | 'wcc';
  source: 'neo4j' | 'local';
  baseZones: number;
  modularity: number | null;
  fallback: boolean;
  fallbackReason: string;
  physicalZoneZones?: number;
  graphNodes?: number;
  graphLinks?: number;
  ranAt: string;
}


export type GraphLayoutPreset = 'force' | 'radial' | 'community';

export interface GraphPhysics {
  linkDistance: number;
  chargeStrength: number;
  centerStrength: number;
  collideRadius: number;
}
