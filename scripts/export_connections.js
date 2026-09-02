#!/usr/bin/env node
/**
 * 导出网络连接关系表（Edge 维度）→ 网络连接关系表_edges.csv
 *
 * 为什么重扫原始日志：Neo4j 的 CONNECTS_TO 按 (src,dst) 对聚合，
 * 逐端口计数（Dest_Port 各自多少次）已被合并丢失，无法从图数据还原。
 * 因此流式重扫 1.9GB 原始 CSV，按 (源IP, 目的IP, 目的端口, 协议) 四元组聚合。
 *
 * 字段：Source_IP, Source_Subnet, Dest_IP, Dest_Subnet, Dest_Port, Protocol,
 *       Connection_Count, Cross_Subnet, Src_In_Whitelist, Dst_In_Whitelist, Whitelist_Status
 *  - Connection_Count = Σ cnt 列（每行代表的连接次数，更接近真实流量；cnt 无效则计 1）
 *  - Whitelist_Status：双向白名单=正常 / 源非白名单 / 目标非白名单 / 双向非白名单（供访问控制审计）
 *
 * 用法：node scripts/export_connections.js [输出路径]
 */
const fs = require('fs');
const readline = require('readline');

const FILE = 'D:\\桌面\\日志-网络访问关系导出数据.csv';
const WHITELIST = 'D:\\Downloads\\资产白名单_最终版.csv';
const OUT = process.argv[2] || 'D:\\Downloads\\网络连接关系表_edges.csv';

function parseCsvLine(line) {
  const out = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += ch; }
    else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur); return out;
}

// ---- 白名单 ----
console.log('读取白名单...');
const rawWl = fs.readFileSync(WHITELIST, 'utf8').replace(/^\uFEFF/, '');
const wlLines = rawWl.split(/\r?\n/).filter(l => l.trim());
const wlHeader = parseCsvLine(wlLines[0]);
const ipIdx = wlHeader.findIndex(h => h === 'IP');
const whitelist = new Set();
for (let i = 1; i < wlLines.length; i++) {
  const cells = parseCsvLine(wlLines[i]);
  const ip = (cells[ipIdx] || '').trim();
  if (ip) whitelist.add(ip);
}
console.log(`白名单 IP 数: ${whitelist.size}`);

const subnetOf = ip => { const p = ip.split('.'); return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.0/24` : '0.0.0.0/0'; };

async function main() {
  // ---- 流式聚合 (src, dst, dport, proto) ----
  console.log('流式扫描原始日志（1.9GB）...');
  const conns = new Map(); // key -> {cnt, src, dst, port, proto}
  const cntDist = { zero: 0, one: 0, gt1: 0, max: 0 };
  let rows = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(FILE, { encoding: 'utf8' }), crlfDelay: Infinity });
  const t0 = Date.now();
  for await (const line of rl) {
    if (!line || line.startsWith('"stringNames"')) continue;
    rows++;
    const parts = line.split(',');
    const get = i => (parts[i] || '').replace(/^"|"$/g, '').trim();
    const src = get(30), dst = get(31);
    if (!src || !dst) continue;
    const port = Number(get(32)) || 0;
    const proto = get(29) || 'tcp';
    const cnt = Number(get(34)) || 0;
    if (cnt === 0) cntDist.zero++;
    else if (cnt === 1) cntDist.one++;
    else { cntDist.gt1++; if (cnt > cntDist.max) cntDist.max = cnt; }
    const key = `${src}|${dst}|${port}|${proto}`;
    let e = conns.get(key);
    if (!e) { e = { src, dst, port, proto, cnt: 0 }; conns.set(key, e); }
    e.cnt += (cnt > 0 ? cnt : 1);
  }
  console.log(`扫描完成: ${rows} 行，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`cnt 列分布: 0=${cntDist.zero} 1=${cntDist.one} >1=${cntDist.gt1} max=${cntDist.max}`);
  console.log(`四元组连接数: ${conns.size}`);

  // ---- 输出 ----
  const header = [
    'Source_IP', 'Source_Subnet', 'Dest_IP', 'Dest_Subnet', 'Dest_Port', 'Protocol',
    'Connection_Count', 'Cross_Subnet', 'Src_In_Whitelist', 'Dst_In_Whitelist', 'Whitelist_Status',
  ];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rowsOut = [header.map(esc).join(',')];
  let bothWl = 0, srcOnly = 0, dstOnly = 0, noneWl = 0;
  for (const e of conns.values()) {
    const sWl = whitelist.has(e.src);
    const dWl = whitelist.has(e.dst);
    const cross = subnetOf(e.src) !== subnetOf(e.dst);
    let status;
    if (sWl && dWl) { status = '双向白名单（正常）'; bothWl++; }
    else if (!sWl && !dWl) { status = '双向非白名单（审计）'; noneWl++; }
    else if (!sWl) { status = '源非白名单（审计）'; srcOnly++; }
    else { status = '目标非白名单（审计）'; dstOnly++; }
    rowsOut.push([
      e.src, subnetOf(e.src), e.dst, subnetOf(e.dst), e.port, e.proto, e.cnt,
      cross ? 'TRUE' : 'FALSE',
      sWl ? '是' : '否', dWl ? '是' : '否', status,
    ].map(esc).join(','));
  }
  fs.writeFileSync(OUT, '\uFEFF' + rowsOut.join('\r\n'), 'utf8');
  const head = fs.readFileSync(OUT).slice(0, 3);
  console.log(`输出: ${OUT}（${conns.size} 行 × ${header.length} 列，BOM=${head.toString('hex')}）`);
  console.log(`白名单状态: 双向白名单=${bothWl} | 源非白名单=${srcOnly} | 目标非白名单=${dstOnly} | 双向非白名单=${noneWl}`);
}
main().catch(e => { console.error(e); process.exit(1); });
