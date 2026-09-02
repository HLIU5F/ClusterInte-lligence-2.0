#!/usr/bin/env node
/**
 * 生成"净化版全量数据"：剔除两个采集大节点，但保留每个节点的完整端口签名
 *
 * 背景：端口信号只记录在边上（节点本身没有 ports 字段），而大部分边连着两个
 * 采集大节点（10.26.0.26 / 10.20.3.25）。物理删除大节点会把端口信号一起删掉。
 * 本脚本的做法（逻辑折叠的数据层）：
 *   1. 先遍历全量边，把每个节点参与过的所有端口聚合到节点 ports 字段（信号保留）
 *   2. 再剔除两个采集大节点及其边（画布/划分无干扰）
 *   3. 输出 public/topology_data_purified.json 供前端"净化数据"按钮加载
 *
 * 用法：node scripts/build_purified_data.js
 */
const fs = require('fs');
const path = require('path');

const INPUT = path.join(__dirname, '..', 'scripts', 'topology_data6.0.json');
const OUTPUT = path.join(__dirname, '..', 'public', 'topology_data_purified.json');
const REMOVE = new Set(['10.26.0.26', '10.20.3.25']);

const data = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
const nodes = data.nodes || [];
const links = data.links || [];

// 1) 聚合每个节点的端口/协议（来自所有边，含大节点的边——信号来源）
const nodePorts = new Map(nodes.map(n => [n.id, new Set()]));
const nodeProtocols = new Map(nodes.map(n => [n.id, new Set()]));
const nid = x => (typeof x === 'string' ? x : x && x.id);

for (const l of links) {
  const a = nid(l.source);
  const b = nid(l.target);
  for (const p of l.ports || []) {
    if (nodePorts.has(a)) nodePorts.get(a).add(Number(p));
    if (nodePorts.has(b)) nodePorts.get(b).add(Number(p));
  }
  for (const pr of l.protocols || []) {
    if (nodeProtocols.has(a)) nodeProtocols.get(a).add(String(pr));
    if (nodeProtocols.has(b)) nodeProtocols.get(b).add(String(pr));
  }
}

// 2) 剔除两个大节点 + 涉及它们的边
const keptNodes = nodes.filter(n => !REMOVE.has(n.id));
const keptLinks = links.filter(l => !REMOVE.has(nid(l.source)) && !REMOVE.has(nid(l.target)));

// 3) 回填 ports / protocols
const outNodes = keptNodes.map(n => ({
  ...n,
  ports: [...(nodePorts.get(n.id) || new Set())].sort((x, y) => x - y),
  protocols: [...(nodeProtocols.get(n.id) || new Set())].sort(),
}));

const out = {
  metadata: {
    ...(data.metadata || {}),
    source: 'purified_no_collectors',
    total_nodes: outNodes.length,
    total_links: keptLinks.length,
    communities: new Set(outNodes.map(n => n.community)).size,
    report: {
      removedCollectors: [...REMOVE],
      removedLinks: links.length - keptLinks.length,
      keptNodes: outNodes.length,
      keptLinks: keptLinks.length,
    },
  },
  nodes: outNodes,
  links: keptLinks,
};

fs.writeFileSync(OUTPUT, JSON.stringify(out, null, 1), 'utf8');
console.log(`已生成 ${OUTPUT}`);
console.log(`  节点: ${outNodes.length}（原 ${nodes.length}，剔除 ${REMOVE.size} 个采集节点）`);
console.log(`  边:   ${keptLinks.length}（原 ${links.length}，剔除 ${links.length - keptLinks.length} 条采集边）`);
console.log(`  端口信号保留: ${outNodes.filter(n => (n.ports || []).some(p => ![36000, 9100, 9101, 1514, 1515, 6514].includes(p))).length}/${outNodes.length} 个节点带业务端口`);
