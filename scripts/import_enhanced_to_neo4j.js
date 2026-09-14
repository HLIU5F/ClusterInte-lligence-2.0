#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const neo4j = require('neo4j-driver');

const JSON_PATH = path.join(__dirname, '..', 'public', 'topology_data_security_enhanced.json');
const URI = 'bolt://127.0.0.1:7687';
const USER = 'neo4j';
const PASSWORD = process.env.NEO4J_PASSWORD || 'REDACTED';
const BATCH = 300;
const ZONE_COLORS = ['#00d4ff','#ff6b35','#a855f7','#10b981','#f59e0b','#ec4899','#22d3ee','#84cc16','#f43f5e','#8b5cf6','#fb923c','#06b6d4'];

function subnetOf(ip) {
  const p = ip.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.0/24` : '0.0.0.0/0';
}

async function main() {
  const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  const nodes = data.nodes || [];
  const links = data.links || [];
  console.log(`读取增强数据: ${nodes.length} 节点 / ${links.length} 边`);

  const driver = neo4j.driver(URI, neo4j.auth.basic(USER, PASSWORD));
  const session = driver.session();
  try {
    // 1) 清空旧数据
    await session.run('MATCH (n) DETACH DELETE n');
    console.log('旧数据已清空');

    // 2) 节点 + 子网
    for (let i = 0; i < nodes.length; i += BATCH) {
      const rows = nodes.slice(i, i + BATCH).map(n => ({
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
        subnet_24: subnetOf(n.id),
        ports: Array.isArray(n.ports) ? n.ports.map(Number) : [],
        protocols: Array.isArray(n.protocols) ? n.protocols : [],
        zone_label: n.zone_label || '',
        zone_id: n.zone_id != null ? String(n.zone_id) : '',
      }));
      await session.run(
        `UNWIND $rows AS r
         MERGE (ip:IP {id: r.id})
         SET ip.ip = r.id, ip.community = r.community, ip.degree = r.degree,
             ip.in_degree = r.in_degree, ip.out_degree = r.out_degree,
             ip.anomaly_score = r.anomaly_score, ip.anomaly_level = r.anomaly_level,
             ip.is_anomaly = r.is_anomaly, ip.is_hub = r.is_hub,
             ip.role_guess = r.role_guess, ip.service_type = r.service_type,
             ip.subnet_24 = r.subnet_24, ip.ports = r.ports, ip.protocols = r.protocols,
             ip.zone_label = r.zone_label, ip.zone_id = r.zone_id
         MERGE (sn:Subnet {cidr: r.subnet_24})
         MERGE (ip)-[:BELONGS_TO]->(sn)`,
        { rows }
      );
    }
    console.log(`节点已导入: ${nodes.length}`);

    // 3) Zone：按 zone_label 去重创建
    const zoneMap = new Map(); // zone_label -> {id, color}
    for (const n of nodes) {
      const zl = n.zone_label;
      if (zl && !zoneMap.has(zl)) {
        const idx = zoneMap.size;
        zoneMap.set(zl, { id: String(idx), color: ZONE_COLORS[idx % ZONE_COLORS.length], label: zl });
      }
    }
    const zoneRows = [...zoneMap.entries()].map(([zl, info]) => ({
      zoneId: info.id, color: info.color, label: info.label, zoneLabel: zl
    }));
    for (let i = 0; i < zoneRows.length; i += BATCH) {
      const rows = zoneRows.slice(i, i + BATCH);
      await session.run(
        `UNWIND $rows AS r
         MERGE (z:Zone {id: r.zoneId})
         ON CREATE SET z.color = r.color, z.label = r.label, z.zone_label = r.zoneLabel`,
        { rows }
      );
    }
    console.log(`Zone 已创建: ${zoneRows.length}`);

    // 4) Subnet -> Zone 关系（按 zone_label 关联）
    for (let i = 0; i < zoneRows.length; i += BATCH) {
      const rows = zoneRows.slice(i, i + BATCH);
      await session.run(
        `UNWIND $rows AS r
         MATCH (z:Zone {id: r.zoneId})
         MATCH (ip:IP {zone_label: r.zoneLabel})-[:BELONGS_TO]->(sn:Subnet)
         MERGE (sn)-[:IN_ZONE]->(z)`,
        { rows }
      );
    }
    console.log('Subnet->Zone 关系已建立');

    // 5) CONNECTS_TO
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
    console.log(`边已导入: ${links.length}`);

    // 校验
    const ipC = await session.run('MATCH (n:IP) RETURN count(n) AS c');
    const zC = await session.run('MATCH (z:Zone) RETURN count(z) AS c');
    const lnkC = await session.run('MATCH (:IP)-[r:CONNECTS_TO]->(:IP) RETURN count(r) AS c');
    console.log(`--- 校验 --- IP: ${ipC.records[0].get('c').toNumber()}, Zone: ${zC.records[0].get('c').toNumber()}, 边: ${lnkC.records[0].get('c').toNumber()}`);
  } finally {
    await session.close();
    await driver.close();
  }
}
main().catch(e => { console.error('导入失败:', e.message); process.exit(1); });
