#!/usr/bin/env node
/**
 * 导入 nodes.csv（Neo4j 标准 CSV 格式：id:ID,:LABEL）到 Neo4j
 *
 * 行为：
 *   1. 逐行解析 CSV（首行表头，之后每行 = 节点 id + label）
 *   2. 按 id MERGE (:IP) 节点（幂等，不会重复创建），并补 subnet_24 属性
 *   3. 关联 (:IP)-[:BELONGS_TO]->(:Subnet)（与 import_to_neo4j.py 的图模型一致）
 *
 * 用法：
 *   node scripts/import_nodes_csv.js
 *   node scripts/import_nodes_csv.js --csv nodes.csv --password neo4j123456
 */
const fs = require('fs');
const path = require('path');
const neo4j = require('neo4j-driver');

const args = process.argv.slice(2);
const get = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const CSV_PATH = get('--csv', path.join(__dirname, '..', 'nodes.csv'));
const URI = get('--uri', 'bolt://127.0.0.1:7687');
const USER = get('--user', 'neo4j');
const PASSWORD = get('--password', 'neo4j123456');
const BATCH = 500;

function subnetOf(ip) {
  const parts = ip.split('.');
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0/24` : '0.0.0.0/0';
}

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`文件不存在: ${CSV_PATH}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(CSV_PATH, 'utf-8').split(/\r?\n/).filter(l => l.trim() !== '');
  const header = lines.shift();
  console.log(`表头: ${header}`);

  const nodes = [];
  const labels = new Set();
  for (const line of lines) {
    const idx = line.indexOf(',');
    const id = (idx >= 0 ? line.slice(0, idx) : line).trim();
    const label = (idx >= 0 ? line.slice(idx + 1) : 'IP').trim();
    if (!id) continue;
    nodes.push({ id, label });
    labels.add(label);
  }
  console.log(`CSV 节点数: ${nodes.length}，标签集合: ${[...labels].join(', ')}`);

  const driver = neo4j.driver(URI, neo4j.auth.basic(USER, PASSWORD));
  const session = driver.session();

  try {
    const before = await session.run('MATCH (n:IP) RETURN count(n) AS c');
    const beforeCount = before.records[0].get('c').toNumber();
    console.log(`导入前 IP 节点: ${beforeCount}`);

    let touched = 0;
    for (let i = 0; i < nodes.length; i += BATCH) {
      const batch = nodes.slice(i, i + BATCH).map(n => ({ ...n, subnet_24: subnetOf(n.id) }));
      const res = await session.run(
        `UNWIND $rows AS r
         MERGE (ip:IP {id: r.id})
         ON CREATE SET ip.ip = r.id, ip.subnet_24 = r.subnet_24, ip.degree = 0, ip.in_degree = 0, ip.out_degree = 0, ip.anomaly_score = 0
         WITH ip, r
         MERGE (sn:Subnet {cidr: r.subnet_24})
         MERGE (ip)-[:BELONGS_TO]->(sn)
         RETURN count(DISTINCT ip) AS c`,
        { rows: batch }
      );
      touched += res.records[0].get('c').toNumber();
      const done = Math.min(i + BATCH, nodes.length);
      if (done === nodes.length || done % (BATCH * 5) === 0) {
        console.log(`已处理 ${done}/${nodes.length}`);
      }
    }

    const after = await session.run('MATCH (n:IP) RETURN count(n) AS c');
    const afterCount = after.records[0].get('c').toNumber();
    const created = afterCount - beforeCount;
    console.log('--- 结果 ---');
    console.log(`导入前 IP 节点: ${beforeCount}`);
    console.log(`本次新增: ${created}`);
    console.log(`导入后 IP 节点: ${afterCount}`);
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(err => {
  console.error('导入失败:', err.message);
  process.exit(1);
});
