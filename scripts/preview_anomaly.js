/**
 * 预演 /api/topology/neo4j 服务端派生逻辑（流量统计 → 角色 → 异常启发式），
 * 用于校准阈值：不修改任何数据，只读 Neo4j 并打印分布结果。
 * 用法: node scripts/preview_anomaly.js
 */
const HTTP = 'http://localhost:7474/db/neo4j/tx/commit';
const AUTH = 'Basic ' + Buffer.from('neo4j:neo4j123456').toString('base64');

async function run(statement) {
  const res = await fetch(HTTP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: AUTH },
    body: JSON.stringify({ statements: [{ statement, resultDataContents: ['row'] }] }),
  });
  const body = await res.json();
  if (body.errors?.length) throw new Error(body.errors[0].message);
  const r = body.results?.[0];
  return (r?.data || []).map(d => d.row);
}

const PORT_ROLE = {
  80: 'web_server', 81: 'web_server', 443: 'web_server', 3000: 'web_server', 5000: 'web_server',
  8000: 'web_server', 8080: 'web_server', 8443: 'web_server', 8888: 'web_server', 9090: 'web_server',
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
};
const DB_PORTS = [3306, 5432, 1433, 1521, 27017, 6379, 11211];
const SCAN_PORTS = new Set([22, 23, 135, 139, 445, 3389, 5900, 5901]);
const CRITICAL_ROLES = new Set(['dns_server', 'database', 'cache', 'message_queue']);
function deriveRole(portCount, nodeId) {
  const has = (p) => portCount.has(p);
  if (KNOWN_COLLECTORS.has(nodeId)) return 'monitoring';
  if (has(9200) || has(9300) || has(5044) || has(9600) || has(5601)
      || (has(9092) && (has(9200) || has(9201) || has(5044) || has(9600) || has(5601)))) return 'data_platform';
  if (has(22) && (has(443) || has(80) || has(8080) || has(8443))) return 'bastion_host';
  const manageHits = [22, 3389, 5900, 5901, 23].filter(p => has(p)).length;
  if (manageHits >= 2) return 'admin_server';
  let domPort = 0, domCnt = 0;
  for (const [p, c] of portCount) { if (c > domCnt) { domCnt = c; domPort = p; } }
  if (domPort === 22 && !has(443) && !has(80) && !has(8080) && !has(8443)) return 'admin_server';
  return domPort ? (PORT_ROLE[domPort] || 'unknown') : 'unknown';
}
const MON_DOM = new Set([36000, 9100, 9101, 6514, 1514, 1515, 1516, 1517, 7070, 9000]);
const KNOWN_COLLECTORS = new Set(['10.26.0.26', '10.20.3.25', '10.100.113.134']);

function percentile(sorted, v) {
  if (!sorted.length) return 0;
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
  return lo / sorted.length;
}

async function main() {
  const [nodeRows, edgeRows] = await Promise.all([
    run('MATCH (ip:IP) WHERE exists((ip)-[:CONNECTS_TO]-()) RETURN ip.id AS id, coalesce(ip.ports,[]) AS ports, ip.subnet_24 AS sn'),
    run('MATCH (a:IP)-[r:CONNECTS_TO]->(b:IP) RETURN a.id AS src, b.id AS dst, coalesce(r.weight,1) AS weight, coalesce(r.ports,[]) AS ports'),
  ]);
  const nodes = new Map(nodeRows.map(([id, ports, sn]) => [id, { ports: new Set(ports.map(Number)), sn }]));
  const inDeg = new Map(), outDeg = new Map(), totalW = new Map(), linkPorts = new Map(), nbrSubnets = new Map();
  const edgeWeights = new Map(), crossSubnetEdges = new Map();
  for (const [s, t, w, ports] of edgeRows) {
    const ww = Number(w) || 1;
    outDeg.set(s, (outDeg.get(s) || 0) + 1);
    inDeg.set(t, (inDeg.get(t) || 0) + 1);
    totalW.set(s, (totalW.get(s) || 0) + ww);
    totalW.set(t, (totalW.get(t) || 0) + ww);
    for (const id of [s, t]) {
      if (!linkPorts.has(id)) linkPorts.set(id, new Set());
      for (const p of ports) linkPorts.get(id).add(Number(p));
      if (!edgeWeights.has(id)) edgeWeights.set(id, []);
      edgeWeights.get(id).push(ww);
    }
    const ss = nodes.get(s)?.sn || '', ts = nodes.get(t)?.sn || '';
    if (ss) { if (!nbrSubnets.has(t)) nbrSubnets.set(t, new Set()); nbrSubnets.get(t).add(ss); }
    if (ts) { if (!nbrSubnets.has(s)) nbrSubnets.set(s, new Set()); nbrSubnets.get(s).add(ts); }
    if (ss && ts && ss !== ts) {
      crossSubnetEdges.set(s, (crossSubnetEdges.get(s) || 0) + 1);
      crossSubnetEdges.set(t, (crossSubnetEdges.get(t) || 0) + 1);
    }
  }
  const collectors = new Set();
  for (const id of nodes.keys()) {
    const deg = (inDeg.get(id) || 0) + (outDeg.get(id) || 0);
    if (KNOWN_COLLECTORS.has(id) || deg >= Math.max(50, Math.ceil(nodes.size * 0.3))) collectors.add(id);
  }
  const degArr = [], wArr = [];
  for (const id of nodes.keys()) {
    if (collectors.has(id)) continue;
    degArr.push((inDeg.get(id) || 0) + (outDeg.get(id) || 0));
    wArr.push(totalW.get(id) || 0);
  }
  degArr.sort((a, b) => a - b);
  wArr.sort((a, b) => a - b);

  const roleCounts = {};
  const levels = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  const flagged = [];
  const lowBuckets = {}; // Low 内部连续分层直方图
  let roleUnknown = 0, criticalCount = 0;
  for (const [id, node] of nodes) {
    const inD = inDeg.get(id) || 0, outD = outDeg.get(id) || 0;
    const deg = inD + outD, w = totalW.get(id) || 0;
    const nbrSubnetCount = nbrSubnets.get(id)?.size || 0;
    const pc = new Map();
    for (const p of node.ports) pc.set(p, (pc.get(p) || 0) + 1);
    for (const p of linkPorts.get(id) || []) pc.set(p, (pc.get(p) || 0) + 1);
    let dom = 0, domC = 0;
    for (const [p, c] of pc) if (c > domC) { domC = c; dom = p; }
    const role = deriveRole(pc, id);
    const isCritical = CRITICAL_ROLES.has(role);
    roleCounts[role] = (roleCounts[role] || 0) + 1;
    if (role === 'unknown') roleUnknown++;
    if (isCritical) criticalCount++;

    let score = 0.15;
    if (!collectors.has(id)) {
      if (dom && MON_DOM.has(dom)) score = 0.05;
      else {
        let scanMax = 0;
        for (const [p, c] of pc) { if (SCAN_PORTS.has(p) && p !== dom && c > scanMax) scanMax = c; }
        if (scanMax >= 3) {
          score = 0.85;
        } else {
          if (role !== 'unknown') {
            const manageHits = [22, 3389, 5900, 5901, 23].filter(p => pc.has(p)).length;
            if (manageHits >= 3) score = Math.max(score, 0.6);
          }
          if (isCritical) {
            score = Math.max(score, 0.1);
            if (nbrSubnetCount >= 3) score = Math.max(score, 0.18);
          } else {
            score += Math.min(0.4, Math.max(0, pc.size - 5) * 0.05 + (pc.size >= 6 ? 0.18 : 0));
            const dbHits = DB_PORTS.filter(p => pc.has(p)).length;
            if (dbHits >= 2) score += 0.25;
            else if (dbHits === 1) score += 0.15;
            if (nbrSubnetCount >= 5) score += 0.15;
            else if (nbrSubnetCount >= 3) score += 0.08;
            if (w >= 8000) score += 0.15;
            else if (w >= 6000) score += 0.1;
            else if (w >= 3000) score += 0.06;
            // ---- 图特征 ----
            const ws = edgeWeights.get(id) || [];
            const nEdges = ws.length;
            if (nEdges > 0) {
              let maxW = 0, sum = 0, lowCnt = 0;
              for (const x of ws) { sum += x; if (x > maxW) maxW = x; if (x <= 2) lowCnt++; }
              const maxShare = sum > 0 ? maxW / sum : 0;
              if (maxShare >= 0.9 && nEdges >= 3) score += 0.1;
              else if (maxShare <= 0.5 && nEdges >= 4) score += 0.12;
              else if (lowCnt >= 3 && nEdges >= 4) score += 0.08;
              const crossShare = (crossSubnetEdges.get(id) || 0) / nEdges;
              if (deg >= 8 && crossShare >= 0.8) score += 0.12;
            }
            if (deg >= 15) score += 0.15;
            else if (deg >= 8) score += 0.08;
          }
        }
      }
    } else score = 0.05;
    score = Math.min(score, 0.95);
    score = Math.round(score * 1000) / 1000;
    const lvl = score >= 0.75 ? 'Critical' : score >= 0.6 ? 'High' : score >= 0.45 ? 'Medium' : 'Low';
    levels[lvl]++;
    if (lvl === 'Low') {
      const b = score <= 0.05 ? '0.05(监控)' : score <= 0.1 ? '0.10(关键资产)' : score <= 0.15 ? '0.15(基线)' : score <= 0.25 ? '0.15-0.25' : '0.25-0.45';
      lowBuckets[b] = (lowBuckets[b] || 0) + 1;
    }
    if (score >= 0.45) flagged.push({ id, deg, w, ports: pc.size, score, lvl, role, dom, critical: isCritical });
  }

  console.log(`nodes=${nodes.size} edges=${edgeRows.length} collectors=${collectors.size}`);
  console.log('roles:', Object.entries(roleCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  '));
  console.log('role unknown:', roleUnknown, '| critical assets:', criticalCount);
  console.log('levels:', Object.entries(levels).map(([k, v]) => `${k}=${v}`).join('  '));
  console.log('low buckets:', Object.entries(lowBuckets).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}=${v}`).join('  '));
  console.log('flagged(>=Medium):', flagged.length);
  flagged.sort((a, b) => b.score - a.score).slice(0, 20).forEach(f =>
    console.log(`  ${f.id} deg=${f.deg} w=${f.w} ports=${f.ports} score=${f.score} ${f.lvl} role=${f.role} dom=${f.dom}${f.critical ? ' [critical]' : ''}`));
}
main().catch(e => { console.error(e); process.exit(1); });
