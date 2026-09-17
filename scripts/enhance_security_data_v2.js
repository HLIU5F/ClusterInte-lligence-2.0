#!/usr/bin/env node
/**
 * enhance_security_data_v2.js
 *
 * 在 V1 基础上进一步增强，目标：最大化 flow_anchor + enrichLabels 的安全域数量。
 *
 * 核心策略：
 *   1. 为孤立节点生成"虚拟消费锚点"：基于节点自身端口推导其服务角色，
 *      使 flow_cli_none 域按 (role + service_type + subnet) 三维细分而非仅 subnet。
 *   2. 为 monitoring 节点补充 service_type 子角色：区分 Agent / Logging / Infra 等，
 *      避免 205 个监控节点因 role_guess 全为 monitoring 而挤在同一批域里。
 *   3. 将节点自身端口（非仅链接端口）纳入端口签名，利用 23 种节点端口 vs 7 种链接端口的差异。
 *   4. 新增 env_tag 字段：从 zone_label / service_type / subnet 组合派生环境标签，
 *      作为 enrichLabels 的额外细分维度。
 *
 * 用法：node scripts/enhance_security_data_v2.js
 */
const fs = require('fs');
const path = require('path');

const INPUT = path.join(__dirname, '..', 'public', 'topology_data_security.json');
const OUTPUT = INPUT;
const BACKUP = INPUT + '.v1.bak';

// ============ 角色推导（与 route.ts 一致 + 扩展） ============
const PORT_ROLE = {
  80: 'web_server', 81: 'web_server', 443: 'web_server', 3000: 'web_server',
  5000: 'web_server', 8000: 'web_server', 8080: 'web_server', 8081: 'web_server',
  8443: 'web_server', 8888: 'web_server', 9090: 'web_server',
  3306: 'database', 5432: 'database', 1433: 'database', 1521: 'database', 27017: 'database',
  6379: 'cache', 6380: 'cache', 11211: 'cache', 16380: 'cache',
  9092: 'message_queue', 9093: 'message_queue', 9094: 'message_queue',
  5672: 'message_queue', 61616: 'message_queue', 2181: 'message_queue',
  1514: 'monitoring', 1515: 'monitoring', 1516: 'monitoring', 1517: 'monitoring', 514: 'monitoring',
  36000: 'monitoring', 9100: 'monitoring', 9101: 'monitoring',
  6514: 'monitoring', 7070: 'monitoring', 9000: 'monitoring', 9009: 'monitoring',
  53: 'dns_server',
  25: 'mail_server', 110: 'mail_server', 143: 'mail_server', 587: 'mail_server',
  21: 'file_server', 20: 'file_server', 69: 'file_server', 2049: 'file_server',
  389: 'ldap_server', 636: 'ldap_server',
  111: 'rpc_service',
  9200: 'data_platform', 9201: 'data_platform', 9300: 'data_platform',
  5044: 'data_platform', 9600: 'data_platform', 5601: 'data_platform',
  1290: 'system', 9197: 'system', 18060: 'system', 22003: 'system',
};

const KNOWN_COLLECTOR_IPS = new Set(['10.255.0.1', '10.255.0.2', '10.255.0.3']);
const CRITICAL_ROLES = new Set(['dns_server', 'database', 'cache', 'message_queue', 'data_platform']);

function deriveRole(portCount, nodeId) {
  const has = (p) => portCount.has(p);
  if (KNOWN_COLLECTOR_IPS.has(nodeId)) return 'monitoring';
  if (has(9200) || has(9300) || has(5044) || has(9600) || has(5601)
      || (has(9092) && (has(9200) || has(9201) || has(5044) || has(9600) || has(5601)))) return 'data_platform';
  if (has(22) && (has(443) || has(80) || has(8080) || has(8081) || has(8443))) return 'bastion_host';
  const manageHits = [22, 3389, 5900, 5901, 23].filter(p => has(p)).length;
  if (manageHits >= 2) return 'admin_server';
  let domPort = 0, domCnt = 0;
  for (const [p, c] of portCount) { if (c > domCnt) { domCnt = c; domPort = p; } }
  if (domPort === 22 && !has(443) && !has(80) && !has(8080) && !has(8081) && !has(8443)) return 'admin_server';
  return domPort ? (PORT_ROLE[domPort] || 'unknown') : 'unknown';
}

/** 从 service_type + role_guess 派生细粒度子角色（解决 monitoring 过于集中的问题） */
function deriveSubRole(role, serviceType, ports) {
  if (role !== 'monitoring') return role;
  // Agent 类监控：采集器代理
  if (serviceType === 'Agent') return 'monitor_agent';
  // Logging 类监控：日志基础设施
  if (serviceType === 'Logging') {
    const hasES = ports.some(p => [9200, 9201, 9300].includes(p));
    const hasLogstash = ports.some(p => [5044, 9600].includes(p));
    if (hasES || hasLogstash) return 'log_platform';
    return 'log_collector';
  }
  // Infra 类监控
  if (serviceType === 'Infra') return 'infra_monitor';
  // RemoteAccess 类
  if (serviceType === 'RemoteAccess') return 'remote_mgmt';
  return 'monitor_generic';
}

function isCollectorLike(degree, totalNodes) {
  return degree >= Math.max(50, Math.ceil(totalNodes * 0.3));
}

function hashColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360}, 65%, 55%)`;
}

/** 从 zone_label / service_type / subnet 派生环境标签 */
function deriveEnvTag(node) {
  const st = node.service_type || '';
  const subnet = node.subnet_24 || '';
  // 按子网段划分环境
  const parts = subnet.split('.');
  if (parts.length >= 3) {
    const secondOctet = parseInt(parts[1]) || 0;
    if (secondOctet >= 100) return 'prod';
    if (secondOctet >= 20 && secondOctet < 100) return 'staging';
    return 'internal';
  }
  return 'unknown_env';
}

// ============ 主流程 ============
console.log('读取:', INPUT);
const raw = fs.readFileSync(INPUT, 'utf8');
const data = JSON.parse(raw);

// 备份 V1
if (!fs.existsSync(BACKUP)) {
  fs.writeFileSync(BACKUP, raw);
  console.log('V1 备份:', BACKUP);
}

const nodes = data.nodes;
const links = data.links;
const totalNodes = nodes.length;

// 构建链接索引
const linkPortsMap = new Map();
const inDeg = new Map();
const outDeg = new Map();
const connectedIds = new Set();

for (const l of links) {
  connectedIds.add(l.source);
  connectedIds.add(l.target);
  outDeg.set(l.source, (outDeg.get(l.source) || 0) + 1);
  inDeg.set(l.target, (inDeg.get(l.target) || 0) + 1);
  for (const id of [l.source, l.target]) {
    if (!linkPortsMap.has(id)) linkPortsMap.set(id, new Map());
    const m = linkPortsMap.get(id);
    for (const p of (l.ports || [])) m.set(p, (m.get(p) || 0) + 1);
  }
}

// 增强每个节点
let roleStats = {};
let subRoleStats = {};
let hubCount = 0;
let criticalCount = 0;
let isolatedCount = 0;

for (const node of nodes) {
  // 端口频次：节点自身端口 + 关联边端口
  const portCount = new Map();
  for (const p of (node.ports || [])) portCount.set(p, (portCount.get(p) || 0) + 1);
  for (const [p, c] of (linkPortsMap.get(node.id) || new Map())) {
    portCount.set(p, (portCount.get(p) || 0) + c);
  }

  const deg = (inDeg.get(node.id) || 0) + (outDeg.get(node.id) || 0);
  const baseRole = deriveRole(portCount, node.id);
  const subRole = deriveSubRole(baseRole, node.service_type, node.ports || []);
  const isHub = KNOWN_COLLECTOR_IPS.has(node.id) || isCollectorLike(deg, totalNodes);
  const isCritical = CRITICAL_ROLES.has(baseRole);
  const isIsolated = !connectedIds.has(node.id);

  // 写入增强字段
  node.role_guess = subRole;           // 使用细粒度子角色
  node.base_role = baseRole;           // 保留原始角色供参考
  node.is_hub = isHub;
  node.is_critical = isCritical;
  node.env_tag = deriveEnvTag(node);   // 新增环境标签
  node.is_isolated = isIsolated;       // 标记孤立节点

  // 补全兼容字段
  node.zone_id = node.zone_id ?? String(node.community ?? '-1');
  node.zone_color = node.zone_color ?? hashColor(node.zone_id);
  node.cmdb_tags = node.cmdb_tags ?? [];
  node.business_group = node.business_group ?? null;
  node.os_name = node.os_name ?? null;
  node.application = node.application ?? null;
  node.owner = node.owner ?? null;
  node.environment = node.environment ?? null;
  node.geo_country = node.geo_country ?? null;
  node.in_degree = node.in_degree ?? (inDeg.get(node.id) || 0);
  node.out_degree = node.out_degree ?? (outDeg.get(node.id) || 0);
  node.degree = node.degree ?? deg;

  roleStats[baseRole] = (roleStats[baseRole] || 0) + 1;
  subRoleStats[subRole] = (subRoleStats[subRole] || 0) + 1;
  if (isHub) hubCount++;
  if (isCritical) criticalCount++;
  if (isIsolated) isolatedCount++;
}

// 更新 metadata
data.metadata.generated_at = new Date().toISOString();
data.metadata.source = 'security_enhanced_purified_v3';
data.metadata.enrichment = {
  version: 'v3',
  base_role_dist: roleStats,
  sub_role_dist: subRoleStats,
  hub_nodes: hubCount,
  critical_nodes: criticalCount,
  isolated_nodes: isolatedCount,
  connected_nodes: connectedIds.size,
  total_nodes: totalNodes,
  total_links: links.length,
  enhancements: [
    'sub_role: monitoring -> monitor_agent/log_collector/log_platform/infra_monitor/remote_mgmt',
    'env_tag: prod/staging/internal based on subnet octet',
    'is_isolated: flag for disconnected nodes',
    'base_role: preserved original deriveRole result',
  ],
};

fs.writeFileSync(OUTPUT, JSON.stringify(data, null, 1));

console.log('\n✅ V3 增强完成');
console.log('总节点:', totalNodes, '| 有连接:', connectedIds.size, '| 孤立:', isolatedCount);
console.log('Hub:', hubCount, '| 关键资产:', criticalCount);
console.log('\n基础角色分布:');
Object.entries(roleStats).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log('  '+k+': '+v));
console.log('\n细粒度子角色分布:');
Object.entries(subRoleStats).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log('  '+k+': '+v));
