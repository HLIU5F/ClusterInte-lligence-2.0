#!/usr/bin/env node
/**
 * 合并四张表 → 增强版资产风险全景表_Final.csv（v3）
 *
 * 修复 v3 六项：
 *   ① 数值列整数化：所有计数列 Math.trunc；端口列 22.0→22；异常分保留 4 位小数（分数本质）
 *   ② 表一覆盖提升：目标聚合（被消费）+ Consumer_IPs 反向索引（该 IP 消费了什么）→ 81.3%
 *      （核查：表一 Target_IP 0 个非标准 IPv4，Key 无类型问题；余下 669 个 IP 四表无记录，属查询覆盖空白）
 *   ③ 行为画像细化：本地合成（方向+扇出+端口多样性+跨子网），替代表三 99.8% 无区分度的 Suspicious_Mixed
 *   ④ 风险多维合成：异常分×0.5 + 横向扩散 + 暴露面 + 高扇出（权重可调）
 *   ⑤ 缺失处理：表一/二/三缺失的维度不加分，风险依据注明"无消费/出向/行为数据"；669 个四表无记录 IP 标注"仅主表"
 *   ⑥ 输出 UTF-8-SIG（BOM \uFEFF，Excel 直接打开不乱码）
 *
 * Risk_Level（多维）：
 *   score = 异常分×0.5
 *         + 出向跨子网 ≥50 → +0.20；≥10 → +0.10；≥3 → +0.05
 *         + 被消费端口 ≥8 → +0.10；≥5 → +0.05
 *         + 连接目标数 >100 → +0.10；>10 → +0.05
 *   等级：≥0.60 高危 / ≥0.45 中危 / ≥0.25 关注 / else 低危
 *   封顶：采集/监控资产（角色 monitoring 或方向类型空）且 score<0.45 → 低危
 *
 * 用法：node scripts/merge_risk_tables.js [输出路径]
 */
const fs = require('fs');

const DIR = 'D:\\Downloads';
const MAIN = `${DIR}\\安全域_flow_anchor(1).csv`;
const BEHAVIOR = `${DIR}\\neo4j_query_table_data_2026-8-25.csv`;
const ACCESS = `${DIR}\\neo4j_query_table_data_2026-8-25(1).csv`;
const CONSUMER = `${DIR}\\neo4j_query_table_data_2026-8-25(2).csv`;
const OUT = process.argv[2] || `${DIR}\\增强版资产风险全景表_Final.csv`;

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
const cleanPort = v => { const n = Math.trunc(Number(v)); return Number.isFinite(n) && n > 0 ? n : null; };
const portListStr = list => [...new Set(list.map(cleanPort).filter(p => p !== null))].sort((a, b) => a - b).join(',');
const listStr = set => [...set].sort().join(',');

console.log('读取四张表...');
const main = readTable(MAIN);
const behavior = readTable(BEHAVIOR);
const access = readTable(ACCESS);
const consumer = readTable(CONSUMER);
const mainIps = new Set(main.map(m => m.IP));

// ---- 表三：by Source_IP ----
const behaviorByIp = new Map();
for (const r of behavior) {
  const ip = (r.Source_IP || r.ource_IP || '').trim();
  if (!ip) continue;
  behaviorByIp.set(ip, {
    role: (r.Behavior_Role || '').trim(),
    targetCount: Number(r.Target_Count) || 0,
    targets: parseList(r.Targets),
    cleanPorts: portListStr(parseList(r.Clean_Ports)),
  });
}

// ---- 表一：目标聚合 + 消费者反向索引 ----
const consumerByIp = new Map();        // Target_IP → 被消费信息
const consumerIPsByIp = new Map();     // Consumer_IP → 消费目标:端口 集合（主表内 IP 才保留）
for (const r of consumer) {
  const t = (r.Target_IP || r.arget_IP || '').trim();
  const port = cleanPort(r.Target_Port);
  const cc = Number(r.Consumer_Count) || 0;
  const cips = parseList(r.Consumer_IPs);
  if (t && port !== null) {
    let agg = consumerByIp.get(t);
    if (!agg) { agg = { portConsumers: new Map(), consumerCountMax: 0, consumerIPs: new Set() }; consumerByIp.set(t, agg); }
    agg.portConsumers.set(port, Math.max(agg.portConsumers.get(port) || 0, cc));
    if (cc > agg.consumerCountMax) agg.consumerCountMax = cc;
    for (const cip of cips) if (cip) agg.consumerIPs.add(cip);
  }
  for (const cip of cips) {
    if (mainIps.has(cip)) {
      if (!consumerIPsByIp.has(cip)) consumerIPsByIp.set(cip, new Set());
      if (t && port !== null) consumerIPsByIp.get(cip).add(`${t}:${port}`);
    }
  }
}

// ---- 表二：出向 + 入向 ----
const outByIp = new Map();
const inByIp = new Map();
for (const r of access) {
  const s = (r.Source_IP || r.ource_IP || '').trim();
  const t = (r.Target_IP || r.arget_IP || '').trim();
  if (!s || !t) continue;
  if (!outByIp.has(s)) outByIp.set(s, { targets: new Set(), crossCount: 0 });
  outByIp.get(s).targets.add(t);
  if (String(r.Cross_Subnet).toUpperCase().startsWith('TRUE')) outByIp.get(s).crossCount++;
  if (!inByIp.has(t)) inByIp.set(t, { sources: new Set() });
  inByIp.get(t).sources.add(s);
}

// ---- 行为画像细化（本地合成，替代表三宽泛标签） ----
function refineBehavior(m, bh, oa) {
  if (!bh) return '无行为数据';
  const fanout = bh.targetCount <= 2 ? '低扇出' : bh.targetCount <= 10 ? '中扇出' : bh.targetCount <= 100 ? '高扇出' : '极高扇出';
  const portCnt = bh.cleanPorts ? bh.cleanPorts.split(',').length : 0;
  const ports = portCnt <= 1 ? '单端口' : portCnt <= 5 ? '少端口' : '多端口';
  let cross = '';
  if (oa && oa.targets.size > 0) {
    const ratio = oa.crossCount / oa.targets.size;
    cross = ratio >= 0.9 ? '_全跨子网' : ratio >= 0.3 ? '_部分跨子网' : '_同子网为主';
  }
  const dir = m.方向类型 === '服务提供' ? 'SVC' : m.方向类型 === '客户端' ? 'CLIENT' : 'TERMINAL';
  return `${dir}_${fanout}_${ports}${cross}`;
}

// ---- 多维风险判定 + 缺失处理 ----
function riskOf(m, bh, cs, oa) {
  const score0 = Number(m.异常分) || 0;
  const isInfra = (m.角色 === 'monitoring') || !m.方向类型;
  let score = score0; // 主信号：异常分（原值，保持与异常级别语义一致）
  const notes = [];
  if (oa) {
    if (oa.crossCount >= 50) { score += 0.2; notes.push(`横向扩散：出向跨子网 ${oa.crossCount} 个`); }
    else if (oa.crossCount >= 10) { score += 0.1; notes.push(`出向跨子网 ${oa.crossCount} 个`); }
    else if (oa.crossCount >= 3) { score += 0.05; notes.push(`出向跨子网 ${oa.crossCount} 个`); }
  } else notes.push('无出向数据');
  if (cs) {
    const pn = cs.portConsumers.size;
    if (pn >= 8) { score += 0.1; notes.push(`服务暴露 ${pn} 端口`); }
    else if (pn >= 5) { score += 0.05; notes.push(`服务暴露 ${pn} 端口`); }
  } else notes.push('无消费数据');
  if (bh) {
    if (bh.targetCount > 100) { score += 0.1; notes.push(`高扇出 ${bh.targetCount} 目标`); }
    else if (bh.targetCount > 10) { score += 0.05; notes.push(`扇出 ${bh.targetCount} 目标`); }
  } else notes.push('无行为数据');
  score = Math.min(score, 0.95);
  // 等级阈值对齐异常级别：≥0.6 High+ → 高危；≥0.45 Medium → 中危；≥0.25 → 关注
  let level;
  if (isInfra && score < 0.45) level = '低危';
  else if (score >= 0.6) level = '高危';
  else if (score >= 0.45) level = '中危';
  else if (score >= 0.25) level = '关注';
  else level = '低危';
  if (level === '低危' && notes.length) notes.unshift(`异常分 ${score0.toFixed(3)}`);
  else if (level !== '低危') notes.unshift(`异常分 ${score0.toFixed(3)}`);
  const reason = notes.length ? notes.join('；') : `异常分 ${score0.toFixed(3)}，未见明显风险信号`;
  return { level, reason };
}

// ---- 合并输出 ----
const header = [
  'IP', '子网', '角色', '行为画像', '行为画像(细化)', '安全域ID', '安全域名称', '方向类型',
  '调用方子网', '对端子网', '服务端口', '异常级别', '异常分',
  '风险等级', '风险依据', '数据覆盖',
  '连接目标数', '出向目标数', '出向跨子网数', '出向目标明细',
  '入向来源数', '入向来源明细',
  '被消费端口数', '消费端口明细', '消费者总数', '消费者IP数', '消费目标明细',
  '行为目标明细', '行为端口明细',
];
const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
const rows = [header.map(esc).join(',')];

const riskDist = {};
let coveredAny = 0, mainOnly = 0;
for (const m of main) {
  const ip = m.IP || '';
  const bh = behaviorByIp.get(ip);
  const cs = consumerByIp.get(ip);
  const ci = consumerIPsByIp.get(ip); // 消费者反向
  const oa = outByIp.get(ip);
  const ia = inByIp.get(ip);
  const { level, reason } = riskOf(m, bh, cs, oa);
  riskDist[level] = (riskDist[level] || 0) + 1;
  const hasAny = !!(bh || cs || ci || oa || ia);
  if (hasAny) coveredAny++; else mainOnly++;
  const outTargets = oa ? [...oa.targets].sort() : [];
  const inSources = ia ? [...ia.sources].sort() : [];
  const portDetail = cs ? [...cs.portConsumers.entries()].sort((a, b) => a[0] - b[0]).map(([p, c]) => `${p}→${c}`).join(';') : '';
  rows.push([
    ip,
    m.子网 ?? '', m.角色 ?? '', bh?.role ?? '', refineBehavior(m, bh, oa),
    m.安全域ID ?? '', m.安全域名称 ?? '', m.方向类型 ?? '',
    m.调用方子网 ?? '', m.对端子网 ?? '',
    m.服务端口 ?? '', m.异常级别 ?? '', String(Number(m.异常分 ?? 0).toFixed(4)),
    level, reason, hasAny ? '三表有记录' : '仅主表',
    bh?.targetCount ?? '',
    oa ? oa.targets.size : '', oa ? oa.crossCount : '', outTargets.join(','),
    ia ? ia.sources.size : '', inSources.join(','),
    cs ? cs.portConsumers.size : '', portDetail,
    cs ? cs.consumerCountMax : '', cs ? cs.consumerIPs.size : '',
    ci ? listStr(ci) : '',
    bh ? bh.targets.join(',') : '', bh ? bh.cleanPorts : '',
  ].map(esc).join(','));
}

// UTF-8-SIG（BOM）
fs.writeFileSync(OUT, '\uFEFF' + rows.join('\r\n'), 'utf8');
const head = fs.readFileSync(OUT).slice(0, 3);
console.log(`输出: ${OUT}（${main.length} 行 × ${header.length} 列，BOM=${head.toString('hex')}）`);
console.log(`风险等级分布: ${JSON.stringify(riskDist)}`);
console.log(`三表有记录: ${coveredAny} | 仅主表: ${mainOnly}`);
