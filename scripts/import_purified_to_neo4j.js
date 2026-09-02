#!/usr/bin/env node
/**
 * 将"净化全量数据"（public/topology_data_purified.json）MERGE 导入 Neo4j
 *
 * 与 restore_core_graph.js 的区别：
 *   - 不清库（增量导入，幂等：按 id MERGE，重复运行不产生重复）
 *   - 节点带完整端口签名（ports 回填自全量边，含采集边信号）
 *   - 采集大节点已剔除（数据层净化）
 *
 * 用法：node scripts/import_purified_to_neo4j.js
 */
const fs = require('fs');
const path = require('path');
const neo4j = require('neo4j-driver');

const JSON_PATH = path.join(__dirname, '..', 'public', 'topology_data_purified.json');
const URI = 'bolt://127.0.0.1:7687';
const USER = 'neo4j';
const PASSWORD = 'neo4j123456';
const BATCH = 300;

const ZONE_COLORS = ['#00d4ff', '#ff6b35', '#a855f7', '#10b981', '#f59e0b', '#ec4899', '#22d3ee', '#84cc16', '#f43f5e', '#8b5cf6', '#fb923c', '#06b6d4'];

function subnetOf(ip) {
  const p = ip.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.0/24` : '0.0.0.0/0';
}

async function main() {
  const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  const nodes = data.nodes || [];
  const links = data.links || [];
  console.log(`读取净化数据: ${nodes.length} 节点 / ${links.length} 边`);

  const driver = neo4j.driver(URI, neo4j.auth.basic(USER, PASSWORD));
  const session = driver.session();
  try {
    // 1) 节点 + 子网 + BELONGS_TO（MERGE，不清库）
    const subnetToComms = new Map();
    for (let i = 0; i < nodes.length; i += BATCH) {
      const rows = nodes.slice(i, i + BATCH).map(n => {
        const sn = subnetOf(n.id);
        if (!subnetToComms.has(sn)) subnetToComms.set(sn, []);
        subnetToComms.get(sn).push(n.community ?? 0);
        return {
          id: n.id,
          community: n.community ?? 0,
          degree: Number(n.degree) || 0,
          in_degree: Number(n.in_degree) || 0,
          out_degree: Number(n.out_degree) || 0,
          anomaly_score: Number(n.anomaly_score) || 0,
          anomaly_level: n.anomaly_level || 'Low',
          is_anomaly: !!n.is_anomaly,
          is_hub: !!n.is_hub,
          role_guess: n.role_guess || 'unknown',
          service_type: n.service_type || null,
          subnet_24: sn,
          ports: Array.isArray(n.ports) ? n.ports.map(Number) : [],
          protocols: Array.isArray(n.protocols) ? n.protocols : [],
        };
      });
      await session.run(
        `UNWIND $rows AS r
         MERGE (ip:IP {id: r.id})
         SET ip.ip = r.id, ip.community = r.community, ip.degree = r.degree,
             ip.in_degree = r.in_degree, ip.out_degree = r.out_degree,
             ip.anomaly_score = r.anomaly_score, ip.anomaly_level = r.anomaly_level,
             ip.is_anomaly = r.is_anomaly, ip.is_hub = r.is_hub,
             ip.role_guess = r.role_guess, ip.service_type = r.service_type,
             ip.subnet_24 = r.subnet_24, ip.ports = r.ports, ip.protocols = r.protocols
         MERGE (sn:Subnet {cidr: r.subnet_24})
         MERGE (ip)-[:BELONGS_TO]->(sn)`,
        { rows }
      );
    }
    console.log(`节点已合并: ${nodes.length}`);

    // 2) Zone（子网按社区多数票）
    const zoneRows = [];
    for (const [cidr, comms] of subnetToComms) {
      const counts = new Map();
      for (const c of comms) counts.set(c, (counts.get(c) || 0) + 1);
      let best = -1, bestN = -1;
      for (const [c, n] of counts) if (n > bestN) { bestN = n; best = c; }
      zoneRows.push({ id: String(best), cidr, color: ZONE_COLORS[best % ZONE_COLORS.length], label: `Zone ${best}` });
    }
    for (let i = 0; i < zoneRows.length; i += BATCH) {
      const rows = zoneRows.slice(i, i + BATCH);
      await session.run(
        `UNWIND $rows AS r
         MERGE (z:Zone {id: r.id})
         ON CREATE SET z.color = r.color, z.label = r.label
         WITH r, z
         MATCH (sn:Subnet {cidr: r.cidr})
         MERGE (sn)-[:IN_ZONE]->(z)`,
        { rows }
      );
    }
    console.log(`Zone 已合并: ${zoneRows.length}`);

    // 3) CONNECTS_TO
    for (let i = 0; i < links.length; i += BATCH) {
      const rows = links.slice(i, i + BATCH).map(l => ({
        src: typeof l.source === 'string' ? l.source : l.source.id,
        dst: typeof l.target === 'string' ? l.target : l.target.id,
        weight: Number(l.weight) || 1,
        bytes: Number(l.bytes) || 0,
        ports: Array.isArray(l.ports) ? l.ports.map(Number) : [],
      }));
      await session.run(
        `UNWIND $rows AS r
         MATCH (a:IP {id: r.src}), (b:IP {id: r.dst})
         MERGE (a)-[rel:CONNECTS_TO {weight: r.weight, bytes: r.bytes}]->(b)
         SET rel.ports = r.ports`,
        { rows }
      );
    }
    console.log(`边已合并: ${links.length}`);

    // 校验
    const ipC = await session.run('MATCH (n:IP) RETURN count(n) AS c');
    const prtC = await session.run('MATCH (n:IP) WHERE size(coalesce(n.ports,[])) > 1 RETURN count(n) AS c');
    const lnkC = await session.run('MATCH (:IP)-[r:CONNECTS_TO]->(:IP) RETURN count(r) AS c');
    console.log(`--- 校验 --- IP: ${ipC.records[0].get('c').toNumber()}, 带端口: ${prtC.records[0].get('c').toNumber()}, 边: ${lnkC.records[0].get('c').toNumber()}`);
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(e => {
  console.error('导入失败:', e.message);
  process.exit(1);
});
