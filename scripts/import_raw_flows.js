#!/usr/bin/env node
/**
 * 正确完整的流量导入：清空 Neo4j → 从原始 CEF 日志（1.9GB）重建全量拓扑
 *
 * 背景：之前只导入了节点 + BELONGS_TO 归属关系，漏掉了用 src/dst/dport 建通信关系。
 * 本脚本：
 *   1. 清空 Neo4j（用户要求清除不需要的数据）
 *   2. 流式解析原始 CSV（1.9GB，约 200 万+ 行）
 *   3. 节点：所有 src/dst IP → (:IP)，聚合其出现过的全部 dport（端口服务签名）与协议
 *   4. 边：按 (src,dst) 对聚合 → (:IP)-[:CONNECTS_TO {weight, ports, protocols}]->(:IP)
 *      （同一对 src→dst 的多次连接合并为一条边，端口集合保留，避免 200 万条裸边）
 *   5. 子网 (:Subnet) + (:IP)-[:BELONGS_TO]->(:Subnet)
 *   6. 重算度数
 *
 * 用法：node scripts/import_raw_flows.js
 */
const fs = require('fs');
const readline = require('readline');
const path = require('path');
const neo4j = require('neo4j-driver');

const FILE = 'D:\\桌面\\日志-网络访问关系导出数据.csv';
const URI = 'bolt://127.0.0.1:7687';
const USER = 'neo4j';
const PASSWORD = 'neo4j123456';
const BATCH = 500;

function parseLine(line) {
  const parts = line.split(',');
  const get = i => (parts[i] || '').replace(/^"|"$/g, '').trim();
  return {
    proto: get(29),
    src: get(30),
    dst: get(31),
    dport: Number(get(32)) || 0,
  };
}

function subnetOf(ip) {
  const p = ip.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.0/24` : '0.0.0.0/0';
}

async function main() {
  console.log('STEP 1/4: 流式解析原始 CSV...');
  const nodes = new Map(); // ip -> {ports:Set, protocols:Set}
  const edges = new Map(); // src|dst -> {weight, ports:Set, protocols:Set}
  let rows = 0;

  const rl = readline.createInterface({ input: fs.createReadStream(FILE, { encoding: 'utf8' }), crlfDelay: Infinity });
  const t0 = Date.now();
  for await (const line of rl) {
    if (!line || line.startsWith('"stringNames"')) continue;
    rows++;
    const r = parseLine(line);
    if (!r.src || !r.dst) continue;
    for (const ip of [r.src, r.dst]) {
      if (!nodes.has(ip)) nodes.set(ip, { ports: new Set(), protocols: new Set() });
      const n = nodes.get(ip);
      if (r.dport) n.ports.add(r.dport);
      if (r.proto) n.protocols.add(r.proto);
    }
    const key = r.src + '|' + r.dst;
    let e = edges.get(key);
    if (!e) { e = { weight: 0, ports: new Set(), protocols: new Set() }; edges.set(key, e); }
    e.weight++;
    if (r.dport) e.ports.add(r.dport);
    if (r.proto) e.protocols.add(r.proto);
  }
  const parseSecs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  解析完成: ${rows} 行 / ${nodes.size} 节点 / ${edges.size} 去重边，耗时 ${parseSecs}s`);

  const driver = neo4j.driver(URI, neo4j.auth.basic(USER, PASSWORD));
  const session = driver.session();
  try {
    console.log('STEP 2/4: 清空数据库...');
    await session.run('MATCH (n) DETACH DELETE n');
    await session.run('CREATE CONSTRAINT ip_id_unique IF NOT EXISTS FOR (n:IP) REQUIRE n.id IS UNIQUE');
    await session.run('CREATE CONSTRAINT subnet_cidr_unique IF NOT EXISTS FOR (n:Subnet) REQUIRE n.cidr IS UNIQUE');
    console.log('  已清空并建唯一约束');

    console.log('STEP 3/4: 导入节点 + 子网 + BELONGS_TO...');
    const nodeList = [...nodes.entries()].map(([id, n]) => ({
      id,
      ports: [...n.ports].sort((a, b) => a - b),
      protocols: [...n.protocols],
      subnet_24: subnetOf(id),
    }));
    for (let i = 0; i < nodeList.length; i += BATCH) {
      const rows = nodeList.slice(i, i + BATCH);
      await session.run(
        `UNWIND $rows AS r
         MERGE (ip:IP {id: r.id})
         SET ip.ip = r.id, ip.ports = r.ports, ip.protocols = r.protocols,
             ip.subnet_24 = r.subnet_24, ip.community = 0, ip.degree = 0
         MERGE (sn:Subnet {cidr: r.subnet_24})
         MERGE (ip)-[:BELONGS_TO]->(sn)`,
        { rows }
      );
      if ((i / BATCH + 1) % 20 === 0) console.log(`  节点 ${Math.min(i + BATCH, nodeList.length)}/${nodeList.length}`);
    }
    console.log(`  节点: ${nodeList.length}`);

    console.log('STEP 4/4: 导入 CONNECTS_TO 边...');
    const edgeList = [...edges.entries()].map(([key, e]) => {
      const [src, dst] = key.split('|');
      return {
        src, dst,
        weight: e.weight,
        ports: [...e.ports].sort((a, b) => a - b),
        protocols: [...e.protocols],
      };
    });
    let written = 0;
    for (let i = 0; i < edgeList.length; i += BATCH) {
      const rows = edgeList.slice(i, i + BATCH);
      const res = await session.run(
        `UNWIND $rows AS r
         MATCH (a:IP {id: r.src}), (b:IP {id: r.dst})
         MERGE (a)-[rel:CONNECTS_TO]->(b)
         SET rel.weight = r.weight, rel.ports = r.ports, rel.protocols = r.protocols
         RETURN count(rel) AS c`,
        { rows }
      );
      written += res.records[0].get('c').toNumber();
      if ((i / BATCH + 1) % 20 === 0) console.log(`  边 ${Math.min(i + BATCH, edgeList.length)}/${edgeList.length}`);
    }
    console.log(`  边: ${written}`);

    // 重算度数
    await session.run('MATCH (ip:IP) SET ip.degree = count{ (ip)-[:CONNECTS_TO]-() }');

    // 校验
    const n = await session.run('MATCH (n:IP) RETURN count(n) AS c');
    const e = await session.run('MATCH (:IP)-[r:CONNECTS_TO]->(:IP) RETURN count(r) AS c');
    const p = await session.run("MATCH (ip:IP) WHERE size(coalesce(ip.ports,[])) > 0 RETURN count(ip) AS c");
    const hh = await session.run(
      `MATCH (a:IP)-[r:CONNECTS_TO]->(b:IP)
       WHERE NOT(a.id IN ['10.26.0.26','10.20.3.25','10.100.113.134'])
         AND NOT(b.id IN ['10.26.0.26','10.20.3.25','10.100.113.134'])
       RETURN count(r) AS c`
    );
    console.log('--- 校验 ---');
    console.log(`  IP 节点: ${n.records[0].get('c').toNumber()}`);
    console.log(`  流边: ${e.records[0].get('c').toNumber()}`);
    console.log(`  带端口节点: ${p.records[0].get('c').toNumber()}`);
    console.log(`  主机间流: ${hh.records[0].get('c').toNumber()}`);
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(e => {
  console.error('导入失败:', e.message);
  process.exit(1);
});
