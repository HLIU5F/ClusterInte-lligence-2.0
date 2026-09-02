#!/usr/bin/env node
/**
 * 精确核查"主机间流量"是否存在：流式扫描 1.9GB 原始 CEF 日志，
 * 按 (src,dst) 与已知采集设备的关系分类：
 *   A. 两端都是已知采集设备（采集器 ↔ 采集器）
 *   B. 恰好一端是已知采集设备（采集器 ↔ 业务主机）→ 采集流/南北向
 *   C. 两端都不是已知采集设备 → 主机间流量候选！
 * 对 C 类进一步看端点是谁（业务主机？网关？公网？），以及方向分布。
 *
 * 用法：node scripts/analyze_host_to_host.js
 */
const fs = require('fs');
const readline = require('readline');

const FILE = 'D:\\桌面\\日志-网络访问关系导出数据.csv';
const KNOWN_COLLECTORS = new Set(['10.26.0.26', '10.20.3.25', '10.100.113.134']);

function parseLine(line) {
  const parts = line.split(',');
  const get = i => (parts[i] || '').replace(/^"|"$/g, '').trim();
  return { src: get(30), dst: get(31) };
}

async function main() {
  const rl = readline.createInterface({ input: fs.createReadStream(FILE, { encoding: 'utf8' }), crlfDelay: Infinity });
  let rows = 0;
  let aRows = 0, bRows = 0, cRows = 0;
  const cPairs = new Map(); // src|dst -> count（C 类去重对）
  const cSrc = new Map();   // C 类流中 src 的频次
  const cDst = new Map();   // C 类流中 dst 的频次
  const t0 = Date.now();
  for await (const line of rl) {
    if (!line || line.startsWith('"stringNames"')) continue;
    rows++;
    const { src, dst } = parseLine(line);
    if (!src || !dst) continue;
    const sK = KNOWN_COLLECTORS.has(src), dK = KNOWN_COLLECTORS.has(dst);
    if (sK && dK) aRows++;
    else if (sK || dK) bRows++;
    else {
      cRows++;
      const key = src + '|' + dst;
      cPairs.set(key, (cPairs.get(key) || 0) + 1);
      cSrc.set(src, (cSrc.get(src) || 0) + 1);
      cDst.set(dst, (cDst.get(dst) || 0) + 1);
    }
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`总行数: ${rows}（耗时 ${secs}s）`);
  console.log(`A 采集器↔采集器: ${aRows} 行`);
  console.log(`B 采集器↔主机: ${bRows} 行`);
  console.log(`C 两端均非已知采集器: ${cRows} 行（${cPairs.size} 个去重对）`);
  console.log('');
  if (cRows > 0) {
    const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
    console.log('C 类流中 src 频次 Top 15:');
    top(cSrc, 15).forEach(([ip, c]) => console.log(`  ${ip}  ${c}`));
    console.log('C 类流中 dst 频次 Top 15:');
    top(cDst, 15).forEach(([ip, c]) => console.log(`  ${ip}  ${c}`));
    console.log('C 类流样例（前 10 个去重对）:');
    let i = 0;
    for (const [key, c] of cPairs) {
      if (i++ >= 10) break;
      console.log(`  ${key}  x${c}`);
    }
    // 两端都在内网 10.x？还是公网/网关？
    let both10 = 0, one10 = 0, none10 = 0;
    for (const key of cPairs.keys()) {
      const [s, d] = key.split('|');
      const s10 = s.startsWith('10.'), d10 = d.startsWith('10.');
      if (s10 && d10) both10++;
      else if (s10 || d10) one10++;
      else none10++;
    }
    console.log(`C 类去重对: 两端都在 10.x=${both10}，一端 10.x=${one10}，都不在=${none10}`);
  } else {
    console.log('结论：原始数据中不存在两端都非已知采集设备的流 —— 主机间流量确实为 0。');
  }
}
main().catch(e => { console.error(e); process.exit(1); });
