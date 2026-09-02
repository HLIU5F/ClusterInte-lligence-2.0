#!/usr/bin/env node
// 核查五个问题的数据事实
const fs = require('fs');
const DIR = 'D:\\Downloads';
const MAIN = `${DIR}\\安全域_flow_anchor(1).csv`;
const BEHAVIOR = `${DIR}\\neo4j_query_table_data_2026-8-25.csv`;
const ACCESS = `${DIR}\\neo4j_query_table_data_2026-8-25(1).csv`;
const CONSUMER = `${DIR}\\neo4j_query_table_data_2026-8-25(2).csv`;

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

const main = readTable(MAIN);
const behavior = readTable(BEHAVIOR);
const access = readTable(ACCESS);
const consumer = readTable(CONSUMER);

console.log('=== ①/③ 主表"服务端口"列浮点检查 ===');
let floatPortRows = 0; const floatSamples = [];
for (const m of main) {
  if (/\.0\b|\d\.\d/.test(m['服务端口'] || '')) { floatPortRows++; if (floatSamples.length < 3) floatSamples.push(`${m.IP}: ${m['服务端口']}`); }
}
console.log(`含浮点端口的行: ${floatPortRows}/${main.length}`);
floatSamples.forEach(s => console.log(`  样例: ${s}`));

console.log('\n=== ② 表一 Key 匹配核查 ===');
const mainIps = new Set(main.map(m => m.IP));
const mainIpsTrim = new Set(main.map(m => (m.IP || '').trim()));
const consumerTargets = new Set();
let consumerTargetRaw = 0;
const mismatchSamples = [];
for (const r of consumer) {
  const t = (r.Target_IP || r.arget_IP || '').trim();
  if (!t) continue;
  consumerTargets.add(t);
  consumerTargetRaw++;
}
let exactHit = 0, trimHit = 0;
for (const t of consumerTargets) { if (mainIps.has(t)) exactHit++; if (mainIpsTrim.has(t)) trimHit++; }
console.log(`表一行数: ${consumer.length} | 去重目标IP: ${consumerTargets.size}`);
console.log(`精确匹配主表: ${exactHit} | trim后匹配: ${trimHit}`);
// 主表里有多少 IP 在表一目标中
let inMain = 0; const mainNoConsumer = [];
for (const m of main) { if (consumerTargets.has(m.IP)) inMain++; else if (mainNoConsumer.length < 5) mainNoConsumer.push(m.IP); }
console.log(`主表 IP 命中表一: ${inMain}/${main.length}（未命中 ${main.length - inMain}）`);
console.log(`未命中样例: ${mainNoConsumer.join(', ')}`);
// 表一目标里有但主表没有的
const onlyConsumer = [...consumerTargets].filter(t => !mainIps.has(t)).slice(0, 5);
console.log(`表一有但主表无的 IP 样例: ${onlyConsumer.join(', ')}（共 ${[...consumerTargets].filter(t => !mainIps.has(t)).length} 个）`);

console.log('\n=== ⑤ 表三 Behavior_Role 分布 ===');
const roleDist = {};
for (const r of behavior) { const v = (r.Behavior_Role || '').trim() || '(空)'; roleDist[v] = (roleDist[v] || 0) + 1; }
console.log(JSON.stringify(roleDist));

console.log('\n=== ④ 表二/表三明细规模 ===');
console.log(`表二行数: ${access.length}`);
const srcSet = new Set(), tgtSet = new Set();
for (const r of access) { const s = (r.Source_IP || r.ource_IP || '').trim(); const t = (r.Target_IP || r.arget_IP || '').trim(); if (s) srcSet.add(s); if (t) tgtSet.add(t); }
console.log(`表二去重源: ${srcSet.size} | 去重目标: ${tgtSet.size}`);
let totalTargets = 0;
for (const r of behavior) { const list = (r.Targets || '').replace(/^\[|\]$/g, '').split(',').filter(s => s.trim()); totalTargets += list.length; }
console.log(`表三 Targets 明细总条目数: ${totalTargets}`);
