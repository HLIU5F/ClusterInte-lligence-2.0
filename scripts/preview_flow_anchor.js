#!/usr/bin/env node
/**
 * 预演 v2：方向感知端口服务域 + 通信锚点域（方案2），
 * 修正方向语义：入向（dst 侧）= 服务提供，出向（src 侧）= 服务消费。
 * 用法：node scripts/preview_flow_anchor.js
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
  return (body.results?.[0]?.data || []).map(d => d.row);
}

const MONITOR_PORTS = new Set([36000, 9100, 9101, 1514, 1515, 6514]);
const KNOWN_COLLECTORS = new Set(['10.26.0.26', '10.20.3.25', '10.100.113.134']);
const CLASS_LABELS = { web: 'Web服务', database: '数据库', cache: '缓存', messaging: '消息队列', email: '邮件', remote: '远程管理', dns: 'DNS', file_transfer: '文件传输', auth: '认证服务', logging: '日志采集', monitoring: '监控', system: '系统服务', other: '其他' };
function classifyPort(p) {
  if ([80,443,8080,8443,8000,3000,5000,8888,9090].includes(p)) return 'web';
  if ([3306,5432,1433,1521,27017,6379,9042,7000].includes(p)) return 'database';
  if ([11211,6379,7000,7001].includes(p)) return 'cache';
  if ([5672,9092,1883,61616,9093,11211].includes(p)) return 'messaging';
  if ([25,110,143,587,993,995].includes(p)) return 'email';
  if ([22,23,3389,5900,5901].includes(p)) return 'remote';
  if ([53,853].includes(p)) return 'dns';
  if ([21,20,69,115,2049].includes(p)) return 'file_transfer';
  if ([88,389,636,1812,1813,8649].includes(p)) return 'auth';
  if ([514,6514,9200,9300,8086,5044].includes(p)) return 'logging';
  if ([161,162,9100,9101,9090].includes(p)) return 'monitoring';
  if (p < 1024) return 'system';
  return 'other';
}
const subnetOf = ip => { const p = ip.split('.'); return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.0/24` : '0.0.0.0/0'; };
function isCollector(id, nbr, total) { return KNOWN_COLLECTORS.has(id) || nbr >= Math.max(50, Math.ceil(total * 0.3)); }
function sigOf(ports) { return [...new Set(ports.map(p => classifyPort(p)))].filter(c => c !== 'other').sort().join('+'); }
const labelOf = sig => sig ? sig.split('+').map(c => CLASS_LABELS[c] || c).join(' + ') : '';

async function main() {
  const [nodeRows, edgeRows] = await Promise.all([
    run('MATCH (ip:IP) WHERE exists((ip)-[:CONNECTS_TO]-()) RETURN ip.id AS id'),
    run('MATCH (a:IP)-[r:CONNECTS_TO]->(b:IP) RETURN a.id AS src, b.id AS dst, coalesce(r.ports,[]) AS ports'),
  ]);
  const nodes = nodeRows.map(([id]) => ({ id }));
  const ids = new Set(nodes.map(n => n.id));
  const links = edgeRows.map(([s, t, ps]) => ({ s, t, ps: new Set(ps.map(Number)) })).filter(l => ids.has(l.s) && ids.has(l.t));

  const inPorts = new Map(), outPorts = new Map(), inCallers = new Map(), outPeers = new Map(), nbr = new Map();
  for (const n of nodes) { inPorts.set(n.id, new Set()); outPorts.set(n.id, new Set()); inCallers.set(n.id, new Set()); outPeers.set(n.id, new Set()); nbr.set(n.id, 0); }
  for (const l of links) {
    for (const p of l.ps) { inPorts.get(l.t)?.add(p); outPorts.get(l.s)?.add(p); }
    inCallers.get(l.t)?.add(subnetOf(l.s));
    outPeers.get(l.s)?.add(subnetOf(l.t));
    nbr.set(l.s, nbr.get(l.s) + 1); nbr.set(l.t, nbr.get(l.t) + 1);
  }

  // ===== 方向感知端口服务域 v2 =====
  const svcZones = new Map(); // key -> {count, label}
  const providerCount = { svc: 0, client: 0, none: 0 };
  for (const n of nodes) {
    if (isCollector(n.id, nbr.get(n.id), nodes.length)) continue;
    const biz = p => !MONITOR_PORTS.has(p);
    const svc = [...inPorts.get(n.id)].filter(biz);
    const con = [...outPorts.get(n.id)].filter(biz);
    const svcSig = sigOf(svc), conSig = sigOf(con);
    let key, label;
    if (svcSig) {
      providerCount.svc++;
      key = `svc_${svcSig}|${subnetOf(n.id)}`;
      label = `${labelOf(svcSig)} · ${subnetOf(n.id)}（服务提供）`;
    } else if (conSig) {
      providerCount.client++;
      key = `cli_${conSig}|${subnetOf(n.id)}`;
      label = `${labelOf(conSig)} 客户端 · ${subnetOf(n.id)}（消费 ${conSig}）`;
    } else {
      providerCount.none++;
      key = `svc_none|${subnetOf(n.id)}`;
      label = `监控终端 · ${subnetOf(n.id)}`;
    }
    if (!svcZones.has(key)) svcZones.set(key, { count: 0, label });
    svcZones.get(key).count++;
  }
  const svcArr = [...svcZones.entries()].sort((a, b) => b[1].count - a[1].count);
  console.log('=== 方向感知端口服务域 v2 ===');
  console.log(`域数: ${svcArr.length} | 服务提供=${providerCount.svc} 客户端=${providerCount.client} 纯监控终端=${providerCount.none}`);
  svcArr.slice(0, 10).forEach(([k, v]) => console.log(`  [${v.count}] ${k}  <- ${v.label}`));

  // ===== 通信锚点域（方案2）v2 =====
  const svcAnchors = new Map(), conAnchors = new Map(); // 节点 → 锚点 key 集合
  const anchorCallers = new Map(), anchorPeers = new Map();
  for (const n of nodes) { svcAnchors.set(n.id, new Set()); conAnchors.set(n.id, new Set()); }
  for (const l of links) {
    for (const p of l.ps) {
      if (!Number.isFinite(Number(p)) || MONITOR_PORTS.has(Number(p))) continue;
      const port = Number(p);
      // 服务锚点：dst 侧（被谁以端口 p 调用）
      const sk = `${l.t}|${port}`;
      if (!anchorCallers.has(sk)) anchorCallers.set(sk, new Set());
      anchorCallers.get(sk).add(subnetOf(l.s));
      svcAnchors.get(l.t)?.add(sk);
      // 消费锚点：src 侧（我以端口 p 访问谁）
      const ck = `${l.s}|${port}`;
      if (!anchorPeers.has(ck)) anchorPeers.set(ck, new Set());
      anchorPeers.get(ck).add(subnetOf(l.t));
      conAnchors.get(l.s)?.add(ck);
    }
  }
  const flowZones = new Map();
  let provider = 0, consumer = 0;
  for (const n of nodes) {
    if (isCollector(n.id, nbr.get(n.id), nodes.length)) continue;
    const svcPorts = new Set(), callers = new Set();
    for (const key of svcAnchors.get(n.id) || []) {
      const idx = key.lastIndexOf('|');
      svcPorts.add(Number(key.slice(idx + 1)));
      for (const cs of anchorCallers.get(key) || []) callers.add(cs);
    }
    const conPorts = new Set(), peers = new Set();
    for (const key of conAnchors.get(n.id) || []) {
      const idx = key.lastIndexOf('|');
      conPorts.add(Number(key.slice(idx + 1)));
      for (const cs of anchorPeers.get(key) || []) peers.add(cs);
    }
    const svcSig = sigOf([...svcPorts]), conSig = sigOf([...conPorts]);
    const subnet = subnetOf(n.id);
    let key, label;
    if (svcSig) {
      provider++;
      const ck = [...callers].sort().join(',');
      key = `svc_${svcSig}|${subnet}${ck ? '|callers:' + ck : ''}`;
      label = `${labelOf(svcSig)} · ${subnet}${ck ? ' · 被 ' + ck + ' 调用' : ''}`;
    } else if (conSig) {
      consumer++;
      const pk = [...peers].sort().join(',');
      key = `cli_${conSig}|${subnet}${pk ? '|peers:' + pk : ''}`;
      label = `${labelOf(conSig)} 客户端 · ${subnet}${pk ? ' · 访问 ' + pk : ''}`;
    } else {
      key = `cli_none|${subnet}`;
      label = `监控终端 · ${subnet}`;
    }
    if (!flowZones.has(key)) flowZones.set(key, { count: 0, label });
    flowZones.get(key).count++;
  }
  const flowArr = [...flowZones.entries()].sort((a, b) => b[1].count - a[1].count);
  console.log('');
  console.log('=== 通信锚点域（方案2）v2 ===');
  console.log(`域数: ${flowArr.length} | 服务提供=${provider} 客户端=${consumer}`);
  flowArr.slice(0, 12).forEach(([k, v]) => console.log(`  [${v.count}] ${k}`));
}
main().catch(e => { console.error(e); process.exit(1); });
