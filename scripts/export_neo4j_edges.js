#!/usr/bin/env node
/**
 * 从 Neo4j 直接导出连接关系表（Edge 表）→ 连接关系表_neo4j.csv
 *
 * 数据源：(:IP)-[:CONNECTS_TO {weight, ports, protocols}]->(:IP)
 * 每条边按 ports 列表逐端口展开一行。
 * 列：Source_IP, Dest_IP, Dest_Port, Protocol, Connection_Count, Source_Subnet, Dest_Subnet, Cross_Subnet
 * 注意：Connection_Count = 该边 weight（(src,dst) 对聚合的行数，边级计数，非逐端口）。
 *       端口级精确计数需重扫原始日志（见 scripts/export_connections.js → 网络连接关系表_edges.csv）。
 *
 * 用法：node scripts/export_neo4j_edges.js [输出路径]
 */
const HTTP = 'http://localhost:7474/db/neo4j/tx/commit';
const AUTH = 'Basic ' + Buffer.from('neo4j:neo4j123456').toString('base64');
const fs = require('fs');

const OUT = process.argv[2] || 'D:\\Downloads\\连接关系表_neo4j.csv';

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

const subnetOf = ip => { const p = ip.split('.'); return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.0/24` : '0.0.0.0/0'; };
const toNumList = v => Array.isArray(v) ? v.map(x => Math.trunc(Number(x))).filter(n => Number.isFinite(n) && n > 0) : [];
const toStringList = v => Array.isArray(v) ? v.map(x => String(x)) : v ? [String(v)] : [];

async function main() {
  console.log('从 Neo4j 查询全部 CONNECTS_TO...');
  const rows = await run(
    'MATCH (a:IP)-[r:CONNECTS_TO]->(b:IP) RETURN a.id AS src, b.id AS dst, coalesce(r.weight,1) AS weight, coalesce(r.ports,[]) AS ports, coalesce(r.protocols,[]) AS protocols'
  );
  console.log(`关系条数: ${rows.length}`);
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['Source_IP', 'Dest_IP', 'Dest_Port', 'Protocol', 'Connection_Count', 'Source_Subnet', 'Dest_Subnet', 'Cross_Subnet'];
  const out = [header.map(esc).join(',')];
  let portRows = 0;
  for (const [src, dst, weight, ports, protocols] of rows) {
    const w = Number(weight) || 1;
    const ps = toNumList(ports);
    const proto = toStringList(protocols).length ? [...new Set(toStringList(protocols))].join('+') : '';
    const cross = subnetOf(src) !== subnetOf(dst);
    if (ps.length === 0) {
      out.push([src, dst, '', proto, String(w), subnetOf(src), subnetOf(dst), cross ? 'TRUE' : 'FALSE'].map(esc).join(','));
      portRows++;
    } else {
      for (const p of ps) {
        out.push([src, dst, String(p), proto, String(w), subnetOf(src), subnetOf(dst), cross ? 'TRUE' : 'FALSE'].map(esc).join(','));
        portRows++;
      }
    }
  }
  fs.writeFileSync(OUT, '\uFEFF' + out.join('\r\n'), 'utf8');
  const head = fs.readFileSync(OUT).slice(0, 3);
  console.log(`输出: ${OUT}（${portRows} 行 × ${header.length} 列，BOM=${head.toString('hex')}）`);
}
main().catch(e => { console.error(e); process.exit(1); });
