#!/usr/bin/env node
/**
 * enhance_security_data.js
 * 
 * 增强 public/topology_data_security.json，补全 role_guess / zone_id / zone_color /
 * is_hub / is_critical 等字段，使本地 JSON 与 Neo4j 加载路径行为一致，
 * 并最大化"方案二+标签细分"的安全域数量。
 * 
 * 用法：node scripts/enhance_security_data.js
 * 输出：覆盖 public/topology_data_security.json（原文件备份为 .bak）
 */
const fs = require('fs');
const path = require('path');

const INPUT = path.join(__dirname, '..', 'public', 'topology_data_security.json');
const OUTPUT = INPUT; // 覆盖写入
const BACKUP = INPUT + '.bak';

// ============ 角色推导（与 src/app/api/topology/neo4j/route.ts 完全一致） ============
const PORT_ROLE = {
  80: 'web_server', 81: 'web_server', 443: 'web_server', 3000: 'web_server', 5000: 'web_server',
  8000: 'web_server', 8080: 'web_server', 8081: 'web_server', 8443: 'web_server', 8888: 'web_server', 9090: 'web_server',
  3306: 'database', 5432: 'database', 1433: 'database', 1521: 'database', 27017: 'database',
  6379: 'cache', 6380: 'cache', 11211: 'cache', 16380: 'cache',
  9092: 'message_queue', 9093: 'message_queue', 9094: 'message_queue',
  5672: 'message_queue', 61616: 'message_queue', 2181: 'message_queue',
  1514: 'monitoring', 1515: 'monitoring', 1516: 'monitoring', 1517: 'monitoring', 514: 'monitoring',
  36000: 'monitoring', 9100: 'monitoring', 9101: 'monitoring',
  6514: 'monitoring', 7070: 'monitoring', 9000: 'monitoring',
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
const SCAN_PORTS = new Set([22, 23, 135, 139, 445, 3389, 5900, 5901]);

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

function isCollectorLike(degree, totalNodes) {
  return degree >= Math.max(50, Math.ceil(totalNodes * 0.3));
}

// ============ Zone ID / Color 生成 ============
function hashColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 65%, 55%)`;
}

// ============ 主流程 ============
console.log('读取:', INPUT);
const raw = fs.readFileSync(INPUT, 'utf8');
const data = JSON.parse(raw);

// 备份
fs.writeFileSync(BACKUP, raw);
console.log('备份:', BACKUP);

const nodes = data.nodes;
const links = data.links;
const totalNodes = nodes.length;

// 1. 构建链接索引：每个节点关联的端口频次
const linkPortsMap = new Map(); // nodeId → Map<port, count>
const inDeg = new Map();
const outDeg = new Map();
for (const l of links) {
  outDeg.set(l.source, (outDeg.get(l.source) || 0) + 1);
  inDeg.set(l.target, (inDeg.get(l.target) || 0) + 1);
  for (const id of [l.source, l.target]) {
    if (!linkPortsMap.has(id)) linkPortsMap.set(id, new Map());
    const m = linkPortsMap.get(id);
    for (const p of (l.ports || [])) {
      m.set(p, (m.get(p) || 0) + 1);
    }
  }
}

// 2. 为每个节点计算 role_guess / is_hub / is_critical
const nodeMap = new Map(nodes.map(n => [n.id, n]));
let roleStats = {};
let hubCount = 0;
let criticalCount = 0;

for (const node of nodes) {
  // 端口频次：节点自身端口 + 关联边端口
  const portCount = new Map();
  for (const p of (node.ports || [])) portCount.set(p, (portCount.get(p) || 0) + 1);
  for (const [p, c] of (linkPortsMap.get(node.id) || new Map())) {
    portCount.set(p, (portCount.get(p) || 0) + c);
  }

  const deg = (inDeg.get(node.id) || 0) + (outDeg.get(node.id) || 0);
  const role = deriveRole(portCount, node.id);
  const isHub = KNOWN_COLLECTOR_IPS.has(node.id) || isCollectorLike(deg, totalNodes);
  const isCritical = CRITICAL_ROLES.has(role);

  node.role_guess = role;
  node.is_hub = isHub;
  node.is_critical = isCritical;
  // 补充缺失字段（兼容前端类型定义）
  node.zone_id = node.zone_id ?? (node.zone_label ? String(node.community) : '-1');
  node.zone_color = node.zone_color ?? hashColor(node.zone_id || node.id);
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

  roleStats[role] = (roleStats[role] || 0) + 1;
  if (isHub) hubCount++;
  if (isCritical) criticalCount++;
}

// 3. 更新 metadata
data.metadata.generated_at = new Date().toISOString();
data.metadata.source = 'security_enhanced_purified_v2';
data.metadata.enrichment = {
  role_guess_filled: nodes.filter(n => n.role_guess !== 'unknown').length,
  hub_nodes: hubCount,
  critical_nodes: criticalCount,
  total_nodes: totalNodes,
  total_links: links.length,
};

// 4. 写回
fs.writeFileSync(OUTPUT, JSON.stringify(data, null, 1));
console.log('\n✅ 增强完成！');
console.log('总节点:', totalNodes);
console.log('总链接:', links.length);
console.log('角色分布:', JSON.stringify(roleStats, null, 2));
console.log('Hub节点:', hubCount);
console.log('关键资产:', criticalCount);
console.log('输出:', OUTPUT);
