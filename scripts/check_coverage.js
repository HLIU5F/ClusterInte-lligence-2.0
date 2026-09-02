#!/usr/bin/env node
// 四表联合覆盖统计
const fs = require('fs');
const DIR = 'D:\\Downloads';
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
function readTable(p) {
  const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  const h = parseCsvLine(lines[0]);
  return lines.slice(1).map(l => { const c = parseCsvLine(l); const r = {}; h.forEach((x, i) => r[x] = c[i] ?? ''); return r; });
}
function parseList(t) {
  if (!t) return [];
  return t.replace(/^\[|\]$/g, '').split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
}
const main = readTable(DIR + '\\安全域_flow_anchor(1).csv');
const access = readTable(DIR + '\\neo4j_query_table_data_2026-8-25(1).csv');
const behavior = readTable(DIR + '\\neo4j_query_table_data_2026-8-25.csv');
const consumer = readTable(DIR + '\\neo4j_query_table_data_2026-8-25(2).csv');
const mainIps = new Set(main.map(m => m.IP));
const targetSet = new Set(), consumerSet = new Set();
for (const r of consumer) {
  const t = (r.Target_IP || r.arget_IP || '').trim();
  if (t) targetSet.add(t);
  for (const ip of parseList(r.Consumer_IPs)) if (mainIps.has(ip)) consumerSet.add(ip);
}
const accSrc = new Set(), accTgt = new Set();
for (const r of access) {
  const s = (r.Source_IP || r.ource_IP || '').trim(), t = (r.Target_IP || r.arget_IP || '').trim();
  if (s) accSrc.add(s); if (t) accTgt.add(t);
}
const behSrc = new Set(behavior.map(r => (r.Source_IP || r.ource_IP || '').trim()).filter(Boolean));
let c2 = 0, c3 = 0, c4 = 0; const never = [];
for (const ip of mainIps) {
  const inT = targetSet.has(ip), inC = consumerSet.has(ip), inA = accSrc.has(ip) || accTgt.has(ip), inB = behSrc.has(ip);
  if (inT || inC || inA || inB) c4++; else never.push(ip);
  if (inT || inC || inA) c3++;
  if (inT || inC) c2++;
}
console.log('表一(目标∪消费者) 覆盖:', c2, '(', (c2 / mainIps.size * 100).toFixed(1), '%)');
console.log('表一∪表二 覆盖:', c3, '(', (c3 / mainIps.size * 100).toFixed(1), '%)');
console.log('四表联合覆盖:', c4, '(', (c4 / mainIps.size * 100).toFixed(1), '%)');
console.log('任何表都无记录的 IP:', never.length, '| 样例:', never.slice(0, 10).join(', '));
