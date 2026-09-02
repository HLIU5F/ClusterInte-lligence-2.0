#!/usr/bin/env node
// 预演：flow_anchor 叠加不同标签的效果对比（决定 enrich 用哪种标签）
const HTTP = 'http://localhost:7474/db/neo4j/tx/commit';
const AUTH = 'Basic ' + Buffer.from('neo4j:neo4j123456').toString('base64');
async function run(statement) {
  const res = await fetch(HTTP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: AUTH },
    body: JSON.stringify({ statements: [{ statement, resultDataContents: ['row'] }] }),
  });
  const b = await res.json();
  return (b.results?.[0]?.data || []).map(d => d.row);
}
(async () => {
  const [nodeRows, edgeRows] = await Promise.all([
    run('MATCH (ip:IP) WHERE exists((ip)-[:CONNECTS_TO]-()) RETURN ip.id AS id, coalesce(ip.ports,[]) AS ports'),
    run('MATCH (a:IP)-[r:CONNECTS_TO]->(b:IP) RETURN a.id AS src, b.id AS dst, coalesce(r.ports,[]) AS ports'),
  ]);
  const MON = new Set([36000, 9100, 9101, 1514, 1515, 6514]);
  const KNOWN = new Set(['10.26.0.26', '10.20.3.25', '10.100.113.134']);
  const PORT_ROLE = { 80: 'web_server', 443: 'web_server', 8080: 'web_server', 8443: 'web_server', 3306: 'database', 5432: 'database', 6379: 'cache', 9092: 'message_queue', 9093: 'message_queue', 9094: 'message_queue', 1514: 'monitoring', 1515: 'monitoring', 1516: 'monitoring', 1517: 'monitoring', 36000: 'monitoring', 9100: 'monitoring', 9101: 'monitoring', 6514: 'monitoring', 53: 'dns_server', 9200: 'data_platform', 9201: 'data_platform', 22: 'admin_server', 111: 'rpc_service' };
  function deriveRole(pc, id) {
    const has = (p) => pc.has(p);
    if (KNOWN.has(id)) return 'monitoring';
    if (has(9200) || has(9300) || has(5044) || has(9600) || has(5601) || (has(9092) && (has(9200) || has(9201) || has(5044) || has(9600) || has(5601)))) return 'data_platform';
    if (has(22) && (has(443) || has(80) || has(8080) || has(8443))) return 'bastion_host';
    if ([22, 3389, 5900, 5901, 23].filter(p => has(p)).length >= 2) return 'admin_server';
    let dom = 0, dc = 0; for (const [p, c] of pc) if (c > dc) { dc = c; dom = p; }
    if (dom === 22 && !has(443) && !has(80) && !has(8080) && !has(8443)) return 'admin_server';
    return dom ? (PORT_ROLE[dom] || 'unknown') : 'unknown';
  }
  const nodes = nodeRows.map(([id, ports]) => ({ id, ports: new Set(ports.map(Number)) }));
  const ids = new Set(nodes.map(n => n.id));
  const links = edgeRows.map(([s, t, ps]) => ({ s, t, ps: new Set(ps.map(Number)) })).filter(l => ids.has(l.s) && ids.has(l.t));
  const subnetOf = ip => { const p = ip.split('.'); return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.0/24` : '0.0.0.0/0'; };
  const inP = new Map(), outP = new Map(), nbr = new Map();
  for (const n of nodes) { inP.set(n.id, new Set()); outP.set(n.id, new Set()); nbr.set(n.id, 0); }
  for (const l of links) { for (const p of l.ps) { inP.get(l.t)?.add(p); outP.get(l.s)?.add(p); } nbr.set(l.s, nbr.get(l.s) + 1); nbr.set(l.t, nbr.get(l.t) + 1); }
  const roles = new Map();
  for (const n of nodes) { const pc = new Map(); for (const p of n.ports) pc.set(p, (pc.get(p) || 0) + 1); roles.set(n.id, deriveRole(pc, n.id)); }
  const cls = p => {
    if ([80, 443, 8080, 8443, 8000, 3000, 5000, 8888, 9090].includes(p)) return 'web';
    if ([3306, 5432, 1433, 1521, 27017, 6379].includes(p)) return 'database';
    if ([11211, 6379].includes(p)) return 'cache';
    if ([5672, 9092, 1883, 61616, 9093].includes(p)) return 'messaging';
    if ([22, 23, 3389, 5900, 5901].includes(p)) return 'remote';
    if ([53, 853].includes(p)) return 'dns';
    if ([514, 6514, 9200, 9300, 8086, 5044].includes(p)) return 'logging';
    if ([161, 162, 9100, 9101].includes(p)) return 'monitoring';
    if (p < 1024) return 'system';
    return 'other';
  };
  const sig = arr => [...new Set(arr.map(cls))].filter(c => c !== 'other').sort().join('+');
  const base = new Map(), withRole = new Map(), withZoneLabel = new Map();
  for (const n of nodes) {
    if (KNOWN.has(n.id) || nbr.get(n.id) >= 50) continue;
    const svc = [...inP.get(n.id)].filter(p => !MON.has(p));
    const con = [...outP.get(n.id)].filter(p => !MON.has(p));
    const sSig = sig(svc), cSig = sig(con);
    const subnet = subnetOf(n.id);
    const kBase = sSig ? 'svc_' + sSig + '|' + subnet : cSig ? 'cli_' + cSig + '|' + subnet : 'none_' + subnet;
    const kRole = kBase + '|role:' + (roles.get(n.id) || 'unknown');
    const portsKey = [...n.ports].sort((a, b) => a - b).join(',');
    const kZone = kBase + '|tag:' + subnet + '|' + portsKey;
    for (const [m, k] of [[base, kBase], [withRole, kRole], [withZoneLabel, kZone]]) m.set(k, (m.get(k) || 0) + 1);
  }
  const stat = m => { const sizes = [...m.values()].sort((a, b) => b - a); return `域数=${m.size} 单节点域=${sizes.filter(s => s === 1).length} 最大域=${sizes[0]}`; };
  console.log('flow_anchor 基础（不叠加）:', stat(base));
  console.log('叠加 role_guess        :', stat(withRole));
  console.log('叠加 deriveZoneLabel   :', stat(withZoneLabel));
})().catch(e => { console.error(e); process.exit(1); });
