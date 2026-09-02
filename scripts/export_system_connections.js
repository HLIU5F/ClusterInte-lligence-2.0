#!/usr/bin/env node
/**
 * 从系统后台导出"系统原生的"原始连接明细表（调用 Next.js 系统 API /api/topology/neo4j）
 *
 * 数据流：系统 API（Neo4j CONNECTS_TO 查询结果）→ 端口展开 → CSV。
 * 未做任何二次加工/合并：Source_IP / Dest_IP / Dest_Port / Protocol / Connection_Count 均来自系统接口。
 * Connection_Count = 系统返回的 weight（(src,dst) 对聚合连接次数，边级）。
 *
 * 用法：node scripts/export_system_connections.js [输出路径]
 */
const fs = require('fs');

const API = 'http://localhost:3000/api/topology/neo4j';
const OUT = process.argv[2] || 'D:\\Downloads\\系统原始连接明细表.csv';

const subnetOf = ip => { const p = ip.split('.'); return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.0/24` : '0.0.0.0/0'; };

async function main() {
  console.log(`调用系统接口: ${API}`);
  const res = await fetch(API, { cache: 'no-store' });
  if (!res.ok) throw new Error(`系统 API 返回 ${res.status}: ${await res.text()}`);
  const data = await res.json();
  console.log(`系统返回: nodes=${data.nodes.length} links=${data.links.length} zones=${data.zones.length}`);

  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['Source_IP', 'Dest_IP', 'Dest_Port', 'Protocol', 'Connection_Count', 'Source_Subnet', 'Dest_Subnet', 'Cross_Subnet'];
  const out = [header.map(esc).join(',')];
  let portRows = 0;
  for (const l of data.links) {
    const s = typeof l.source === 'string' ? l.source : l.source?.id ?? String(l.source);
    const t = typeof l.target === 'string' ? l.target : l.target?.id ?? String(l.target);
    const w = Number(l.weight) || 1;
    const ports = Array.isArray(l.ports) ? l.ports.map(x => Math.trunc(Number(x))).filter(n => Number.isFinite(n) && n > 0) : [];
    const protocols = Array.isArray(l.protocols) ? l.protocols : [];
    const proto = protocols.length ? [...new Set(protocols)].join('+') : '';
    const cross = subnetOf(s) !== subnetOf(t);
    if (ports.length === 0) {
      out.push([s, t, '', proto, String(w), subnetOf(s), subnetOf(t), cross ? 'TRUE' : 'FALSE'].map(esc).join(','));
      portRows++;
    } else {
      for (const p of ports) {
        out.push([s, t, String(p), proto, String(w), subnetOf(s), subnetOf(t), cross ? 'TRUE' : 'FALSE'].map(esc).join(','));
        portRows++;
      }
    }
  }
  fs.writeFileSync(OUT, '\uFEFF' + out.join('\r\n'), 'utf8');
  const head = fs.readFileSync(OUT).slice(0, 3);
  console.log(`输出: ${OUT}（${portRows} 行 × ${header.length} 列，BOM=${head.toString('hex')}）`);
}
main().catch(e => { console.error(e); process.exit(1); });
