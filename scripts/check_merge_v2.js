#!/usr/bin/env node
// 核查 v2 最终文件数值列形态 + 表一消费者反向覆盖
const fs = require('fs');
const DIR = 'D:\\Downloads';
const MAIN = `${DIR}\\安全域_flow_anchor(1).csv`;
const CONSUMER = `${DIR}\\neo4j_query_table_data_2026-8-25(2).csv`;
const FINAL = `${DIR}\\增强版资产风险全景表_Final.csv`;

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
function readTable(path) {
  const raw = fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map(l => {
    const cells = parseCsvLine(l); const row = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    return row;
  });
}
function parseList(text) {
  if (!text) return [];
  return text.replace(/^\[|\]$/g, '').split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

const main = readTable(MAIN);
const consumer = readTable(CONSUMER);
const final = readTable(FINAL);

console.log('=== 问题1：最终文件数值列形态检查 ===');
const numCols = ['异常分', '连接目标数', '出向目标数', '出向跨子网数', '入向来源数', '被消费端口数', '消费者总数', '消费者IP数'];
for (const c of numCols) {
  const vals = new Set();
  for (const r of final) { if (r[c] !== '') vals.add(r[c]); }
  const hasFloat = [...vals].filter(v => /\.\d/.test(v)).slice(0, 5);
  console.log(`  ${c}: 唯一值样例 [${[...vals].slice(0, 3).join(', ')}]${hasFloat.length ? ' | 含浮点: ' + hasFloat.join(', ') : ' | 无浮点'}`);
}

console.log('\n=== 问题2：表一 Key 与覆盖深挖 ===');
// 表一 Target_IP 格式核查
const badFormat = [];
for (const r of consumer) {
  const t = (r.Target_IP || r.arget_IP || '').trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) badFormat.push(t);
}
console.log(`表一 Target_IP 非标准 IPv4 格式: ${[...new Set(badFormat)].length} 个（样例: ${[...new Set(badFormat)].slice(0, 5).join(', ')}）`);
// 消费者反向覆盖
const mainIps = new Set(main.map(m => m.IP));
const targetSet = new Set();
const consumerSet = new Set();
let parsed = 0;
for (const r of consumer) {
  const t = (r.Target_IP || r.arget_IP || '').trim();
  if (t) targetSet.add(t);
  const ips = parseList(r.Consumer_IPs);
  for (const ip of ips) { if (mainIps.has(ip)) consumerSet.add(ip); }
  parsed++;
}
console.log(`表一目标 IP（去重）: ${targetSet.size} | 消费者 IP（去重，主表内）: ${consumerSet.size}`);
const covered = new Set([...targetSet, ...consumerSet]);
let inMainCovered = 0; const notCovered = [];
for (const ip of mainIps) { if (covered.has(ip)) inMainCovered++; else if (notCovered.length < 8) notCovered.push(ip); }
console.log(`目标∪消费者 覆盖主表: ${inMainCovered}/${mainIps.size}（${(inMainCovered / mainIps.size * 100).toFixed(1)}%）`);
console.log(`仍未覆盖的 IP 样例: ${notCovered.join(', ')}`);
console.log(`表一行数: ${parsed}（Consumer_IPs 解析 OK）`);
