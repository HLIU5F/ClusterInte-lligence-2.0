/**
 * GET /api/topology/gds
 *
 * 从 Neo4j 读取已持久化的 GDS 算法结果：
 *   - 每个 IP 的 gds_louvain / gds_wcc / gds_pagerank 值
 *   - GDSZone 节点信息（按算法分组的社区）
 *   - PageRank Top 20 枢纽节点
 */

import { NextResponse } from 'next/server';
import { runCypher } from '@/lib/neo4j';

interface GDSNodeRecord {
  ip: string;
  gds_louvain: number | null;
  gds_wcc: number | null;
  gds_pagerank: number | null;
}

interface GDSZoneRecord {
  algorithm: string;
  community: number;
  label: string;
  color: string;
  ip_count: number;
}

export async function GET() {
  try {
    // 1) 获取所有带 GDS 属性的 IP 节点
    const nodeRecords = await runCypher<GDSNodeRecord>(`
      MATCH (ip:IP)
      WHERE ip.gds_louvain IS NOT NULL 
         OR ip.gds_wcc IS NOT NULL 
         OR ip.gds_pagerank IS NOT NULL
      RETURN 
        ip.id AS ip,
        ip.gds_louvain AS gds_louvain,
        ip.gds_wcc AS gds_wcc,
        ip.gds_pagerank AS gds_pagerank
    `);

    // 2) 获取所有 GDSZone 节点
    const zoneRecords = await runCypher<GDSZoneRecord>(`
      MATCH (gz:GDSZone)
      RETURN 
        gz.algorithm AS algorithm,
        gz.community AS community,
        gz.label AS label,
        gz.color AS color,
        coalesce(gz.ip_count, 0) AS ip_count
      ORDER BY gz.algorithm, gz.community
    `);

    // 3) 获取 PageRank Top 20 枢纽节点
    const hubNodes = await runCypher<{ ip: string; score: number }>(`
      MATCH (ip:IP)
      WHERE ip.gds_pagerank IS NOT NULL
      RETURN ip.id AS ip, ip.gds_pagerank AS score
      ORDER BY ip.gds_pagerank DESC
      LIMIT 20
    `);

    // 构建返回数据
    const nodes = nodeRecords.map(r => ({
      ip: r.ip,
      gds_louvain: r.gds_louvain != null ? Number(r.gds_louvain) : undefined,
      gds_wcc: r.gds_wcc != null ? Number(r.gds_wcc) : undefined,
      gds_pagerank: r.gds_pagerank != null ? Number(r.gds_pagerank) : undefined,
    }));

    const zones = zoneRecords.map(r => ({
      algorithm: r.algorithm,
      community: Number(r.community),
      label: r.label,
      color: r.color,
      ip_count: Number(r.ip_count),
    }));

    const hubNodesFormatted = hubNodes.map(r => ({
      ip: r.ip,
      score: Number(r.score),
    }));

    return NextResponse.json({
      nodes,
      zones,
      hubNodes: hubNodesFormatted,
    });
  } catch (error: any) {
    console.error('GDS topology API error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch GDS topology data' },
      { status: 500 }
    );
  }
}
