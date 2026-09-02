#!/usr/bin/env node
/**
 * 导入全量流量关系（CONNECTS_TO：源IP-目的IP-端口）到 Neo4j
 *
 * 背景：当前 Neo4j 只有 211 条监控边（核心子图），而全量流数据（6499 条 src-dst-port）
 * 一直存在于 scripts/topology_data6.0.json，从未完整入库——这就是"动态关系缺失"的根因。
 *
 * 本脚本：
 *   1. 恢复两个被净化移除的采集节点（10.26.0.26 / 10.20.3.25，标记 is_hub/collector）
 *   2. 把全量 6499 条流 MERGE 为 (:IP)-[:CONNECTS_TO {weight, bytes, ports, protocols}]->(:IP)
 *   3. 重算每个节点的 degree
 *
 * 注意：全量流中主机间流 = 0（全部连接采集节点），这是采集数据的天性；
 * 真正的主机间业务流（NetFlow/防火墙日志）需要新的数据源，见说明。
 *
 * 用法：node scripts/import_full_flows.js
 */
const fs = require('fs');
const path = require('path');
const neo4j = require('neo4j-driver');

const JSON_PATH = path.join(__dirname, '..', 'scripts', 'topology_data6.0.json');
const URI = 'bolt://127.0.0.1:7687';
const USER = 'neo4j';
const PASSWORD = 'neo4j123456';
const BATCH = 500;

const nid = x => (typeof x === 'string' ? x : x && x.id);

async function main() {
  const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  const links = data.links || [];
  console.log(`读取全量流: ${links.length} 条`);

  const driver = neo4j.driver(URI, neo4j.auth.basic(USER, PASSWORD));
  const session = driver.session();
  try {
    // 1) 确保两个采集节点存在（净化时被移除，流端点需要它们）
    const hubs = ['10.26.0.26', '10.20.3.25'];
    await session.run(
      `UNWIND $rows AS r
       MERGE (ip:IP {id: r.id})
       SET ip.ip = r.id, ip.is_hub = true, ip.role_guess = 'collector', ip.degree = 0`,
      { rows: hubs.map(id => ({ id })) }
    );
    console.log('采集节点已恢复（is_hub/collector 标记）');

    // 2) 批量 MERGE 全量流边（按端点去重，更新 weight/ports）
    let touched = 0;
    for (let i = 0; i < links.length; i += BATCH) {
      const rows = links.slice(i, i + BATCH).map(l => ({
        src: nid(l.source),
        dst: nid(l.target),
        weight: Number(l.weight) || 1,
        bytes: Number(l.bytes) || 0,
        ports: (l.ports || []).map(Number),
        protocols: (l.protocols || []).map(String),
      }));
      const res = await session.run(
        `UNWIND $rows AS r
         MATCH (a:IP {id: r.src}), (b:IP {id: r.dst})
         MERGE (a)-[rel:CONNECTS_TO]->(b)
         SET rel.weight = r.weight, rel.bytes = r.bytes,
             rel.ports = r.ports, rel.protocols = r.protocols
         RETURN count(rel) AS c`,
        { rows }
      );
      touched += res.records[0].get('c').toNumber();
      const done = Math.min(i + BATCH, links.length);
      if (done === links.length || done % (BATCH * 5) === 0) {
        console.log(`已处理 ${done}/${links.length}`);
      }
    }
    console.log(`流边写入: ${touched}`);

    // 3) 重算度数
    await session.run('MATCH (ip:IP) SET ip.degree = size((ip)-[:CONNECTS_TO]-())');

    // 校验
    const e = await session.run('MATCH (:IP)-[r:CONNECTS_TO]->(:IP) RETURN count(r) AS c');
    const hh = await session.run(
      `MATCH (a:IP)-[r:CONNECTS_TO]->(b:IP)
       WHERE NOT(a.id IN ['10.26.0.26','10.20.3.25','10.100.113.134'])
         AND NOT(b.id IN ['10.26.0.26','10.20.3.25','10.100.113.134'])
       RETURN count(r) AS c`
    );
    const n = await session.run('MATCH (n:IP) RETURN count(n) AS c');
    const p = await session.run("MATCH ()-[r:CONNECTS_TO]->() WHERE size(coalesce(r.ports,[])) > 0 RETURN count(r) AS c");
    console.log('--- 校验 ---');
    console.log(`  总流边: ${e.records[0].get('c').toNumber()}`);
    console.log(`  带端口的流: ${p.records[0].get('c').toNumber()}`);
    console.log(`  主机间流: ${hh.records[0].get('c').toNumber()}`);
    console.log(`  IP 节点: ${n.records[0].get('c').toNumber()}`);
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(e => {
  console.error('导入失败:', e.message);
  process.exit(1);
});
