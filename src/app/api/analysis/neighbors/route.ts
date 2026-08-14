// N跳邻居扩展 - 从指定节点向外扩展N跳范围的所有邻居

import { NextRequest, NextResponse } from 'next/server';
import neo4j, { Driver } from 'neo4j-driver';

let driver: Driver | null = null;

function toNum(value: any): number {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof value.toNumber === 'function') return value.toNumber();
  return Number(value) || 0;
}

function getDriver(): Driver {
  if (!driver) {
    driver = neo4j.driver(
      process.env.NEO4J_URI || 'bolt://localhost:7687',
      neo4j.auth.basic(
        process.env.NEO4J_USER || 'neo4j',
        process.env.NEO4J_PASSWORD || 'password'
      )
    );
  }
  return driver;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { nodeId, hops = 2, includePaths = true } = body;

    if (!nodeId) {
      return NextResponse.json(
        { error: '需要提供 nodeId' },
        { status: 400 }
      );
    }

    const safeHops = Math.min(Math.max(parseInt(hops) || 2, 1), 5);
    const d = getDriver();
    const session = d.session({ database: process.env.NEO4J_DATABASE || 'neo4j' });

    try {
      // 获取N跳内所有邻居节点及其最短距离
      const nodesResult = await session.run(
        `
        MATCH path = (start:IP {id: $nodeId})-[:CONNECTS_TO*1..${safeHops}]-(neighbor:IP)
        WITH neighbor, min(length(path)) AS distance
        RETURN neighbor.id AS id,
               neighbor.role_guess AS role_guess,
               neighbor.service_type AS service_type,
               neighbor.anomaly_score AS anomaly_score,
               neighbor.is_anomaly AS is_anomaly,
               neighbor.community AS community,
               neighbor.degree AS degree,
               neighbor.bytes_sent AS bytes_sent,
               neighbor.bytes_received AS bytes_received,
               distance
        ORDER BY distance ASC
        `,
        { nodeId }
      );

      // 同时获取起点节点信息
      const startNodeResult = await session.run(
        `
        MATCH (n:IP {id: $nodeId})
        RETURN n.id AS id, n.role_guess AS role_guess, n.service_type AS service_type,
               n.anomaly_score AS anomaly_score, n.is_anomaly AS is_anomaly,
               n.community AS community, n.degree AS degree
        `,
        { nodeId }
      );

      // 获取这些节点之间的所有连接边
      const allNodeIds = nodesResult.records.map(r => r.get('id'));
      allNodeIds.unshift(nodeId); // 包含起点

      let edges: any[] = [];
      if (allNodeIds.length > 1) {
        const edgesResult = await session.run(
          `
          MATCH (a:IP)-[r:CONNECTS_TO]-(b:IP)
          WHERE a.id IN $nodeIds AND b.id IN $nodeIds
          RETURN DISTINCT a.id AS source, b.id AS target,
                 r.weight AS weight, r.ports AS ports
          `,
          { nodeIds: allNodeIds }
        );

        edges = edgesResult.records.map(rec => ({
          source: rec.get('source'),
          target: rec.get('target'),
          weight: toNum(rec.get('weight')) || 1,
          ports: rec.get('ports') || [],
        }));
      }

      // 构造结果
      const neighbors = nodesResult.records.map(rec => ({
        id: rec.get('id'),
        role_guess: rec.get('role_guess'),
        service_type: rec.get('service_type'),
        anomaly_score: toNum(rec.get('anomaly_score')),
        is_anomaly: rec.get('is_anomaly') || false,
        community: toNum(rec.get('community')),
        degree: toNum(rec.get('degree')),
        bytes_sent: toNum(rec.get('bytes_sent')),
        bytes_received: toNum(rec.get('bytes_received')),
        distance: toNum(rec.get('distance')),
      }));

      const startNode = startNodeResult.records.length > 0 ? {
        id: startNodeResult.records[0].get('id'),
        role_guess: startNodeResult.records[0].get('role_guess'),
        service_type: startNodeResult.records[0].get('service_type'),
        anomaly_score: toNum(startNodeResult.records[0].get('anomaly_score')),
        is_anomaly: startNodeResult.records[0].get('is_anomaly') || false,
        community: toNum(startNodeResult.records[0].get('community')),
        degree: toNum(startNodeResult.records[0].get('degree')),
        distance: 0,
      } : null;

      // 按距离分组统计
      const distanceStats: Record<number, number> = {};
      for (const n of neighbors) {
        distanceStats[n.distance] = (distanceStats[n.distance] || 0) + 1;
      }

      return NextResponse.json({
        centerNode: startNode,
        neighbors,
        edges,
        totalNodes: neighbors.length + 1, // +1 for center
        totalEdges: edges.length,
        hops: safeHops,
        distanceStats,
      });
    } finally {
      await session.close();
    }
  } catch (error: any) {
    console.error('Neighbors expansion error:', error);
    return NextResponse.json(
      { error: error.message || '邻居扩展查询失败' },
      { status: 500 }
    );
  }
}
