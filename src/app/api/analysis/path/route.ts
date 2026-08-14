// 最短路径查询 - 分析两个 IP 之间的攻击链/通信路径

import { NextRequest, NextResponse } from 'next/server';
import neo4j, { Driver } from 'neo4j-driver';

let driver: Driver | null = null;

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
    const { source, target, maxHops = 10 } = body;

    if (!source || !target) {
      return NextResponse.json(
        { error: '需要提供 source 和 target IP' },
        { status: 400 }
      );
    }

    const safeMaxHops = Math.min(Math.max(parseInt(maxHops) || 10, 1), 20);
    const d = getDriver();
    const session = d.session({ database: process.env.NEO4J_DATABASE || 'neo4j' });

    try {
      // 查找最短路径
      const result = await session.run(
        `
        MATCH path = shortestPath(
          (a:IP {id: $source})-[:CONNECTS_TO*1..${safeMaxHops}]-(b:IP {id: $target})
        )
        WITH path, 
             [n IN nodes(path) | n.id] AS nodeIds,
             [n IN nodes(path) | {
               id: n.id,
               role_guess: n.role_guess,
               service_type: n.service_type,
               anomaly_score: n.anomaly_score,
               is_anomaly: n.is_anomaly
             }] AS nodeDetails,
             [r IN relationships(path) | {
               source: startNode(r).id,
               target: endNode(r).id,
               weight: r.weight,
               ports: r.ports
             }] AS edgeDetails
        RETURN nodeIds, nodeDetails, edgeDetails, length(path) AS pathLength
        `,
        { source, target }
      );

      if (result.records.length === 0) {
        // 尝试反向
        const reverseResult = await session.run(
          `
          MATCH path = shortestPath(
            (a:IP {id: $target})-[:CONNECTS_TO*1..${safeMaxHops}]-(b:IP {id: $source})
          )
          WITH path,
               [n IN nodes(path) | n.id] AS nodeIds,
               [n IN nodes(path) | {
                 id: n.id,
                 role_guess: n.role_guess,
                 service_type: n.service_type,
                 anomaly_score: n.anomaly_score,
                 is_anomaly: n.is_anomaly
               }] AS nodeDetails,
               [r IN relationships(path) | {
                 source: startNode(r).id,
                 target: endNode(r).id,
                 weight: r.weight,
                 ports: r.ports
               }] AS edgeDetails
          RETURN nodeIds, nodeDetails, edgeDetails, length(path) AS pathLength
          `,
          { source, target }
        );

        if (reverseResult.records.length === 0) {
          return NextResponse.json({
            found: false,
            message: `${source} 和 ${target} 之间没有可达路径（最大 ${safeMaxHops} 跳）`,
            nodes: [],
            edges: [],
            pathLength: 0,
          });
        }

        const rec = reverseResult.records[0];
        return NextResponse.json({
          found: true,
          nodes: rec.get('nodeDetails'),
          edges: rec.get('edgeDetails'),
          nodeIds: rec.get('nodeIds'),
          pathLength: rec.get('pathLength').toNumber(),
        });
      }

      const rec = result.records[0];
      return NextResponse.json({
        found: true,
        nodes: rec.get('nodeDetails'),
        edges: rec.get('edgeDetails'),
        nodeIds: rec.get('nodeIds'),
        pathLength: rec.get('pathLength').toNumber(),
      });
    } finally {
      await session.close();
    }
  } catch (error: any) {
    console.error('Path analysis error:', error);
    return NextResponse.json(
      { error: error.message || '路径查询失败' },
      { status: 500 }
    );
  }
}
