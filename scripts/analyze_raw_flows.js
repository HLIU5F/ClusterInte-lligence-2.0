#!/usr/bin/env node
/**
 * 全量分析原始流量 CSV（D:\桌面\日志-网络访问关系导出数据.csv）
 * 流式读取 1.9GB，统计：行数 / 去重节点 / 去重边 / 端口分布 / 主机间流量占比
 */
const fs = require('fs');
const readline = require('readline');

const FILE = 'D:\\桌面\\日志-网络访问关系导出数据.csv';
const KNOWN_DEVICES = new Set(['10.26.0.26', '10.20.3.25', '10.100.113.134']);

function parseLine(line) {
  // CEF 行：字段带引号，简单按逗号切分后取前 33 列（proto/src/dst/dport 在 30-33 位）
  const parts = line.split(',');
  const get = i => (parts[i] || '').replace(/^"|"$/g, '').trim();
  return {
    proto: get(29),
    src: get(30),
    dst: get(31),
    dport: Number(get(32)) || 0,
    dir: get(33),
  };
}

const nodes = new Set();
const edges = new Map(); // src|dst -> {ports:Set, weight}
const portFreq = new Map();
const protoFreq = new Map();
let rows = 0, hostHost = 0, deviceTouching = 0, bad = 0;

const rl = readline.createInterface({ input: fs.createReadStream(FILE, { encoding: 'utf8' }), crlfDelay: Infinity });
const t0 = Date.now();

rl.on('line', (line) => {
  if (!line || line.startsWith('"stringNames"')) return;
  rows++;
  const r = parseLine(line);
  if (!r.src || !r.dst) { bad++; return; }
  nodes.add(r.src); nodes.add(r.dst);
  if (r.proto) protoFreq.set(r.proto, (protoFreq.get(r.proto) || 0) + 1);
  if (r.dport) portFreq.set(r.dport, (portFreq.get(r.dport) || 0) + 1);
  const key = r.src + '|' + r.dst;
  let e = edges.get(key);
  if (!e) { e = { ports: new Set(), weight: 0 }; edges.set(key, e); }
  e.weight++;
  if (r.dport) e.ports.add(r.dport);
  if (KNOWN_DEVICES.has(r.src) || KNOWN_DEVICES.has(r.dst)) deviceTouching++; else hostHost++;
});

rl.on('close', () => {
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`耗时: ${secs}s, 总行数(去表头): ${rows}`);
  console.log(`去重节点(src+dst): ${nodes.size}`);
  console.log(`去重边(src→dst 对): ${edges.size}`);
  console.log(`触及已知设备(10.26.0.26/10.20.3.25/10.100.113.134)的流: ${deviceTouching} (${(deviceTouching / rows * 100).toFixed(1)}%)`);
  console.log(`真正的主机间流(两端都不是已知设备): ${hostHost} (${(hostHost / rows * 100).toFixed(1)}%)`);
  console.log('=== 端口频次 Top 20 ===');
  [...portFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([p, c]) => console.log(`  ${p}: ${c}`));
  console.log('=== 协议分布 ===');
  [...protoFreq.entries()].forEach(([k, c]) => console.log(`  ${k}: ${c}`));
  console.log('=== 边权重分布（一对 src→dst 出现次数） ===');
  const w = [...edges.values()].map(e => e.weight).sort((a, b) => a - b);
  console.log(`  最少 ${w[0]}, 中位 ${w[Math.floor(w.length / 2)]}, 最大 ${w[w.length - 1]}`);
  console.log('=== 去重边中带端口(≥1个 dport)的比例 ===');
  console.log(`  ${[...edges.values()].filter(e => e.ports.size > 0).length} / ${edges.size}`);
});
