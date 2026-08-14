/**
 * GET /api/topology/neo4j
 *
 * 一次性把整套拓扑数据从 Neo4j 拉回前端：
 *   - metadata（节点数 / 边数 / 社区数 / 时间戳）
 *   - nodes[]   （每个 IP 附 subnet_24、zone_id、zone_color、anomaly 字段）
 *   - links[]   （CONNECTS_TO 关系）
 *   - zones[]   （每个安全域的 id / label / color / ip 数 / subnet 数）
 *
 * 前端拿到的就是「按 Zone 颜色一致」的数据源，渲染层不用再自己算颜色。
 */

import { NextResponse } from 'next/server';
import { runCypher } from '@/lib/neo4j';

interface IpRecord {
  id: string;
  community: number;
  subnet_24: string;
  subnet_cidr?: string;
  zone_id: string | null;
  zone_color: string | null;
  zone_label: string | null;
  degree: number;
  in_degree: number;
  out_degree: number;
  anomaly_score: number;
  is_hub: boolean;
  service_type: string | null;
  geo_country: string | null;
  business_group: string | null;
  os_name: string | null;
  application: string | null;
  owner: string | null;
  environment: string | null;
  cmdb_tags: string[] | null;
}

interface LinkRecord {
  src: string;
  dst: string;
  weight: number;
  bytes: number;
}

interface ZoneRecord {
  id: string;
  label: string;
  color: string;
  ips: number;
  subnets: number;
}

export async function GET() {
  try {
    // 1) 节点 + 它们的 Subnet + Zone（一次 JOIN 取齐）
    // Run the three topology queries in parallel instead of serially.
    const [ipRecords, linkRecords, zoneRecords] = await Promise.all([
      runCypher<IpRecord>(`
        MATCH (ip:IP)
        OPTIONAL MATCH (ip)-[:BELONGS_TO]->(sn:Subnet)
        OPTIONAL MATCH (sn)-[:IN_ZONE]->(z:Zone)
        OPTIONAL MATCH (ip)-[:BELONGS_TO_GROUP]->(bg:BusinessGroup)
        OPTIONAL MATCH (ip)-[:RUNS_ON]->(os:OS)
        OPTIONAL MATCH (ip)-[:RUNS_APP]->(app:Application)
        OPTIONAL MATCH (ip)-[:IN_ENVIRONMENT]->(env:Environment)
        RETURN
          ip.id           AS id,
          ip.community    AS community,
          ip.subnet_24    AS subnet_24,
          sn.cidr         AS subnet_cidr,
          z.id            AS zone_id,
          z.color         AS zone_color,
          z.label         AS zone_label,
          coalesce(ip.degree, 0)        AS degree,
          coalesce(ip.in_degree, 0)     AS in_degree,
          coalesce(ip.out_degree, 0)    AS out_degree,
          coalesce(ip.anomaly_score, 0) AS anomaly_score,
          coalesce(ip.is_hub, false)    AS is_hub,
          ip.service_type               AS service_type,
          ip.geo_country                AS geo_country,
          head(collect(DISTINCT bg.name)) AS business_group,
          head(collect(DISTINCT os.name)) AS os_name,
          head(collect(DISTINCT app.name)) AS application,
          ip.owner                      AS owner,
          head(collect(DISTINCT env.name)) AS environment,
          coalesce(ip.cmdb_tags, [])    AS cmdb_tags
      `),
      runCypher<LinkRecord>(`
        MATCH (a:IP)-[r:CONNECTS_TO]->(b:IP)
        RETURN a.id AS src, b.id AS dst,
               coalesce(r.weight, 1) AS weight,
               coalesce(r.bytes, 0)  AS bytes
      `),
      runCypher<ZoneRecord>(`
        MATCH (z:Zone)
        OPTIONAL MATCH (sn:Subnet)-[:IN_ZONE]->(z)
        OPTIONAL MATCH (ip:IP)-[:BELONGS_TO]->(sn)
        WITH z, count(DISTINCT sn) AS subnets, count(DISTINCT ip) AS ips
        RETURN z.id AS id, z.label AS label, z.color AS color,
               ips, subnets
        ORDER BY z.id
      `),
    ]);

    // 用 ipRecords 构建节点数组（zone_color / zone_id 都是 Neo4j 直接给的，没有就 fallback 到 -1 域）
    const nodes = ipRecords.map(r => ({
      id: r.id,
      community: r.community,
      subnet_24: r.subnet_24 ?? r.subnet_cidr ?? '0.0.0.0/0',
      zone_id: r.zone_id ?? '-1',
      zone_color: r.zone_color ?? '#64748b',
      zone_label: r.zone_label ?? 'Unassigned',
      degree: Number(r.degree) || 0,
      in_degree: Number(r.in_degree) || 0,
      out_degree: Number(r.out_degree) || 0,
      anomaly_score: Number(r.anomaly_score) || 0,
      is_anomaly: (Number(r.anomaly_score) || 0) > 0.6,
      anomaly_level:
        (Number(r.anomaly_score) || 0) > 0.75 ? 'Critical' :
        (Number(r.anomaly_score) || 0) > 0.60 ? 'High' :
        (Number(r.anomaly_score) || 0) > 0.45 ? 'Medium' : 'Low',
      is_hub: !!r.is_hub,
      service_type: r.service_type,
      geo_country: r.geo_country,
      business_group: r.business_group ?? null,
      os_name: r.os_name ?? null,
      application: r.application ?? null,
      owner: r.owner ?? null,
      environment: r.environment ?? null,
      cmdb_tags: Array.isArray(r.cmdb_tags) ? r.cmdb_tags : [],
      // 角色猜一猜：可后端 build 时算好，前端这里给个 default
      role_guess: r.service_type ?? 'unknown',
    }));

    // 给每条边附上 "是否跨 zone"（前端直接用，不用再算）
    const ipZone = new Map(nodes.map(n => [n.id, n.zone_id]));
    const links = linkRecords.map(l => ({
      source: l.src,
      target: l.dst,
      weight: Number(l.weight) || 1,
      bytes: Number(l.bytes) || 0,
      is_cross_domain: (ipZone.get(l.src) ?? '') !== (ipZone.get(l.dst) ?? ''),
    }));

    return NextResponse.json({
      metadata: {
        generated_at: new Date().toISOString(),
        source: 'neo4j',
        total_nodes: nodes.length,
        total_links: links.length,
        communities: new Set(nodes.map(n => n.community)).size,
      },
      nodes,
      links,
      zones: zoneRecords,
    });
  } catch (err) {
    console.error('[api/topology/neo4j] error:', err);
    return NextResponse.json(
      {
        error: 'Failed to load from Neo4j',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
