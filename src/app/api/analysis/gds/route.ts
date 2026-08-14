/**
 * GDS 动态分区端点
 *
 * POST /api/analysis/gds
 *   body: { algorithm?: 'louvain'|'wcc'|'pagerank'|'all', persist?: boolean }
 *
 * 流程：
 *   1) 投影图（幂等：先 drop 老投影）
 *   2) 流式跑算法
 *   3) (可选) 持久化到 (:IP {gds_xxx}) + (:GDSZone {algorithm, community}) + (:IP)-[:IN_GDS_ZONE]
 *   4) drop 投影
 *
 * 返回：
 *   { graph: {nodeCount,relationshipCount}, results: {...}, persisted: true|false }
 */
import { NextResponse } from 'next/server';
import { runCypher } from '@/lib/neo4j';

type Algo = 'louvain' | 'wcc' | 'pagerank' | 'all' | 'physical_zone';

const GRAPH_NAME = 'ci-graph';

/**
 * 动态生成 N 个区分度高的颜色（HSL 均匀分布）。
 * 用于安全域数量远超固定调色板时的着色。
 */
function generateColors(n: number): string[] {
  if (n <= 0) return [];
  const colors: string[] = [];
  // 黄金角步进，保证相邻颜色差异最大
  const goldenAngle = 137.508;
  for (let i = 0; i < n; i++) {
    const hue = (i * goldenAngle) % 360;
    // 饱和度和亮度在合理范围微调，保证深色背景下可读
    const sat = 65 + (i % 3) * 10; // 65 / 75 / 85
    const light = 55 + (i % 2) * 8; // 55 / 63
    colors.push(hslToHex(hue, sat, light));
  }
  return colors;
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const color = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

async function projectGraph(): Promise<{ nodeCount: number; relationshipCount: number }> {
  // 1) drop 老投影（如果存在）
  await runCypher(`CALL gds.graph.drop($name, false) YIELD graphName`, { name: GRAPH_NAME });

  // 2) 创建新投影：IP 节点 + CONNECTS_TO 关系，UNDIRECTED（社区划分的物理意义）
  const rows = await runCypher<{ nodeCount: number; relationshipCount: number }>(
    `CALL gds.graph.project($name, 'IP', {
        CONNECTS_TO: { orientation: 'UNDIRECTED', properties: ['weight'] }
     })
     YIELD graphName, nodeCount, relationshipCount
     RETURN nodeCount, relationshipCount`,
    { name: GRAPH_NAME }
  );
  return rows[0];
}

async function dropGraph() {
  await runCypher(`CALL gds.graph.drop($name, false) YIELD graphName`, { name: GRAPH_NAME });
}

async function runLouvain(maxLevels: number = 2): Promise<Array<{ ip: string; community: number }>> {
  return runCypher<{ ip: string; community: number }>(
    `CALL gds.louvain.stream($name, { maxIterations: 50, maxLevels: $maxLevels, includeIntermediateCommunities: false })
     YIELD nodeId, communityId
     RETURN gds.util.asNode(nodeId).id AS ip, communityId AS community`,
    { name: GRAPH_NAME, maxLevels: maxLevels }
  );
}


/**
 * 规则聚类降级：按 /24 网段 + IP 尾号分块生成 physical_zone。
 * 尾号每 10 个一档：0-9, 10-19, 20-29 ... 250-255
 * 示例：192.168.1.35 → "192.168.1_block_30_39"
 */
async function runPhysicalZone(): Promise<Array<{ ip: string; physical_zone: string }>> {
  return runCypher<{ ip: string; physical_zone: string }>(`
    MATCH (ip:IP)
    WHERE ip.id IS NOT NULL
    WITH ip, split(ip.id, '.') AS parts
    WHERE size(parts) = 4
    WITH ip,
         parts[0] + '.' + parts[1] + '.' + parts[2] AS subnet,
         toInteger(parts[3]) AS lastOctet
    WITH ip, subnet, lastOctet,
         (lastOctet / 10) * 10 AS blockStart,
         CASE
           WHEN (lastOctet / 10) * 10 + 9 > 255 THEN 255
           ELSE (lastOctet / 10) * 10 + 9
         END AS blockEnd
    SET ip.physical_zone = subnet + '_block_' + toString(blockStart) + '_' + toString(blockEnd)
    RETURN ip.id AS ip, ip.physical_zone AS physical_zone
  `);
}
async function runWCC(): Promise<Array<{ ip: string; component: number }>> {
  return runCypher<{ ip: string; component: number }>(
    `CALL gds.wcc.stream($name)
     YIELD nodeId, componentId
     RETURN gds.util.asNode(nodeId).id AS ip, componentId AS component`,
    { name: GRAPH_NAME }
  );
}

async function runPageRank(): Promise<Array<{ ip: string; score: number }>> {
  return runCypher<{ ip: string; score: number }>(
    `CALL gds.pageRank.stream($name, { relationshipWeightProperty: 'weight' })
     YIELD nodeId, score
     RETURN gds.util.asNode(nodeId).id AS ip, score`,
    { name: GRAPH_NAME }
  );
}

/**
 * 把 Louvain 分区结果写回 Neo4j：
 *   - :IP 节点添加 gds_louvain 属性
 *   - 新建 (:GDSZone {algorithm: 'louvain', community, color, label, ip_count})
 *   - 关系 (:IP)-[:IN_GDS_ZONE]->(:GDSZone)
 */
async function persistLouvain(
  rows: Array<{ ip: string; community: number }>
): Promise<{ zones: number; members: number }> {
  // 1) 清掉旧 louvain GDSZone + 旧属性（保证幂等）
  await runCypher(`MATCH (gz:GDSZone {algorithm: 'louvain'}) DETACH DELETE gz`);
  await runCypher(`MATCH (ip:IP) WHERE ip.gds_louvain IS NOT NULL REMOVE ip.gds_louvain`);

  // 动态生成调色板：按实际社区数生成，保证每域有独立颜色
  const uniqueCommunities = Array.from(new Set(rows.map((r) => r.community)));
  const COLORS = generateColors(Math.max(uniqueCommunities.length, 12));

  const summary = await runCypher<{ zones: number; members: number }>(
    `
    UNWIND $rows AS r
    MATCH (ip:IP {id: r.ip})
    SET ip.gds_louvain = r.community
    WITH r.community AS zoneId, collect(ip) AS members
    MERGE (gz:GDSZone {algorithm: 'louvain', community: zoneId})
    ON CREATE SET
       gz.color      = $colors[(zoneId % size($colors))],
       gz.label      = 'Louvain-' + toString(zoneId),
       gz.ip_count   = size(members),
       gz.members    = [m IN members | m.id],
       gz.created_at = datetime()
    WITH gz, members
    UNWIND members AS m
    MATCH (ip2:IP {id: m.id})
    MERGE (ip2)-[:IN_GDS_ZONE]->(gz)
    RETURN count(DISTINCT gz) AS zones, count(m) AS members
    `,
    { rows, colors: COLORS }
  );
  return summary[0];
}

/**
 * 把 WCC 结果写回 Neo4j（结构同上，但 algorithm='wcc'，属性名为 gds_wcc）
 */
/**
 * 规则聚类降级：持久化 physical_zone 到 GDSZone 节点
 */
async function persistPhysicalZone(
  rows: Array<{ ip: string; physical_zone: string }>,
  asLouvain = false
): Promise<{ zones: number; members: number }> {
  const algorithm = asLouvain ? 'louvain' : 'physical_zone';
  const nodeProperty = asLouvain ? 'gds_louvain' : 'gds_physical_zone';
  const labelPrefix = asLouvain ? 'Louvain' : 'PZone';

  // 1) 清掉旧的同算法 GDSZone + 旧属性
  await runCypher(`MATCH (gz:GDSZone {algorithm: $alg}) DETACH DELETE gz`, { alg: algorithm });
  await runCypher(`MATCH (ip:IP) WHERE ip.${nodeProperty} IS NOT NULL REMOVE ip.${nodeProperty}`);

  // 2) 为每个 unique zone 分配序号
  const zoneList = Array.from(new Set(rows.map((r) => r.physical_zone))).sort();
  const zoneIndex = new Map<string, number>();
  zoneList.forEach((z, i) => zoneIndex.set(z, i));
  const COLORS = generateColors(Math.max(zoneList.length, 12));

  // 3) 构建带序号的行数据
  const indexedRows = rows.map((r) => ({
    ip: r.ip,
    zoneIdx: zoneIndex.get(r.physical_zone)!,
  }));

  // 4) 批量写入
  const summary = await runCypher<{ zones: number; members: number }>(
    `
    UNWIND $rows AS r
    MATCH (ip:IP {id: r.ip})
    SET ip.${nodeProperty} = r.zoneIdx
    WITH r.zoneIdx AS zoneId, collect(ip) AS members
    MERGE (gz:GDSZone {algorithm: $alg, community: zoneId})
    ON CREATE SET
       gz.color      = $colors[(zoneId % size($colors))],
       gz.label      = $labelPrefix + '-' + toString(zoneId),
       gz.ip_count   = size(members),
       gz.members    = [m IN members | m.id],
       gz.created_at = datetime()
    WITH gz, members
    UNWIND members AS m
    MATCH (ip2:IP {id: m.id})
    MERGE (ip2)-[:IN_GDS_ZONE]->(gz)
    RETURN count(DISTINCT gz) AS zones, count(m) AS members
    `,
    { rows: indexedRows, colors: COLORS, alg: algorithm, labelPrefix }
  );
  return summary[0];
}
async function persistWCC(
  rows: Array<{ ip: string; component: number }>
): Promise<{ zones: number; members: number }> {
  await runCypher(`MATCH (gz:GDSZone {algorithm: 'wcc'}) DETACH DELETE gz`);
  await runCypher(`MATCH (ip:IP) WHERE ip.gds_wcc IS NOT NULL REMOVE ip.gds_wcc`);

  const uniqueComponents = Array.from(new Set(rows.map((r) => r.component)));
  const COLORS = generateColors(Math.max(uniqueComponents.length, 12));

  const summary = await runCypher<{ zones: number; members: number }>(
    `
    UNWIND $rows AS r
    MATCH (ip:IP {id: r.ip})
    SET ip.gds_wcc = r.component
    WITH r.component AS zoneId, collect(ip) AS members
    MERGE (gz:GDSZone {algorithm: 'wcc', community: zoneId})
    ON CREATE SET
       gz.color      = $colors[(zoneId % size($colors))],
       gz.label      = 'WCC-' + toString(zoneId),
       gz.ip_count   = size(members),
       gz.members    = [m IN members | m.id],
       gz.created_at = datetime()
    WITH gz, members
    UNWIND members AS m
    MATCH (ip2:IP {id: m.id})
    MERGE (ip2)-[:IN_GDS_ZONE]->(gz)
    RETURN count(DISTINCT gz) AS zones, count(m) AS members
    `,
    { rows, colors: COLORS }
  );
  return summary[0];
}

async function persistPageRank(rows: Array<{ ip: string; score: number }>): Promise<number> {
  await runCypher(`MATCH (ip:IP) REMOVE ip.gds_pagerank`);
  const result = await runCypher<{ count: number }>(
    `
    UNWIND $rows AS r
    MATCH (ip:IP {id: r.ip})
    SET ip.gds_pagerank = r.score
    RETURN count(ip) AS count
    `,
    { rows }
  );
  return result[0]?.count || 0;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      algorithm?: Algo;
      persist?: boolean;
      maxLevels?: number;
    };
    const algorithm: Algo = body.algorithm || 'all';
    const persist: boolean = body.persist !== false; // 默认持久化
    const maxLevels: number = body.maxLevels ?? 2; // 默认层级 2，产生更多社区

    // 1) 投影
    const graph = await projectGraph();

    const results: any = { graph, maxLevels };

    // 2) Louvain（带降级检测）
    if (algorithm === 'louvain' || algorithm === 'all') {
      const LOUVAIN_MIN_COMMUNITIES = 2;
      const LOUVAIN_MIN_MODULARITY = 0.2;

      const louvain = await runLouvain(maxLevels);
      const uniqueCommunities = Array.from(new Set(louvain.map((r) => r.community))).length;

      // 尝试获取模块度
      let modularity: number | null = null;
      try {
        const stats = await runCypher<{ modularity: number }>(
          `CALL gds.louvain.stats($name) YIELD modularity RETURN modularity`,
          { name: GRAPH_NAME }
        );
        if (stats.length > 0) modularity = stats[0].modularity;
      } catch {
        // gds.louvain.stats 不可用时忽略，仅依赖社区数判定
      }

      const needsFallback =
        uniqueCommunities < LOUVAIN_MIN_COMMUNITIES ||
        (modularity !== null && modularity < LOUVAIN_MIN_MODULARITY);

      results.louvain = {
        count: louvain.length,
        communities: uniqueCommunities,
        modularity,
        fallback: needsFallback,
        sample: louvain.slice(0, 5),
      };

      if (needsFallback) {
        // 降级：使用规则聚类
        const pz = await runPhysicalZone();
        const zones = Array.from(new Set(pz.map((r) => r.physical_zone))).length;
        results.louvain.physical_zone = {
          count: pz.length,
          zones,
          sample: pz.slice(0, 5),
        };
        if (persist) {
          const sum = await persistPhysicalZone(pz, true);
          results.louvain.physical_zone.persisted = sum;
          results.louvain.persisted = sum;
        }
      } else if (persist) {
        const sum = await persistLouvain(louvain);
        results.louvain.persisted = sum;
      }
    }

    // 2b) Physical Zone（独立触发）
    if (algorithm === 'physical_zone') {
      const pz = await runPhysicalZone();
      const zones = Array.from(new Set(pz.map((r) => r.physical_zone))).length;
      results.physical_zone = {
        count: pz.length,
        zones,
        sample: pz.slice(0, 5),
      };
      if (persist) {
        const sum = await persistPhysicalZone(pz);
        results.physical_zone.persisted = sum;
      }
    }

    // 3) WCC
    if (algorithm === 'wcc' || algorithm === 'all') {
      const wcc = await runWCC();
      results.wcc = {
        count: wcc.length,
        components: Array.from(new Set(wcc.map((r) => r.component))).length,
        sample: wcc.slice(0, 5),
      };
      if (persist) {
        const sum = await persistWCC(wcc);
        results.wcc.persisted = sum;
      }
    }

    // 4) PageRank
    if (algorithm === 'pagerank' || algorithm === 'all') {
      const pr = await runPageRank();
      pr.sort((a, b) => b.score - a.score);
      results.pagerank = {
        count: pr.length,
        top: pr.slice(0, 10),
      };
      if (persist) {
        const n = await persistPageRank(pr);
        results.pagerank.persisted = n;
      }
    }

    // 5) drop 投影
    await dropGraph();

    return NextResponse.json({ success: true, ...results });
  } catch (e: any) {
    console.error('[/api/analysis/gds] error:', e);
    return NextResponse.json(
      { success: false, error: e.message || String(e) },
      { status: 500 }
    );
  }
}

export async function GET() {
  // 列出当前库内已持久化的 GDS 区，便于前端"展示已跑历史"
  try {
    const zones = await runCypher<{
      algorithm: string;
      zone_count: number;
      total_ips: number;
    }>(
      `MATCH (gz:GDSZone)
       RETURN gz.algorithm AS algorithm, count(gz) AS zone_count, sum(gz.ip_count) AS total_ips
       ORDER BY algorithm`
    );
    const top = await runCypher<{ ip: string; score: number }>(
      `MATCH (ip:IP) WHERE ip.gds_pagerank IS NOT NULL
       RETURN ip.id AS ip, ip.gds_pagerank AS score
       ORDER BY score DESC LIMIT 10`
    );
    // 返回每个安全域的详细信息（颜色 + IP 数），供前端"一条线"展示
    const zoneDetails = await runCypher<{
      algorithm: string;
      community: number;
      label: string;
      color: string;
      ip_count: number;
    }>(
      `MATCH (gz:GDSZone)
       RETURN gz.algorithm AS algorithm, gz.community AS community,
              gz.label AS label, gz.color AS color, gz.ip_count AS ip_count
       ORDER BY gz.algorithm, gz.ip_count DESC`
    );
    return NextResponse.json({
      success: true,
      zones,
      topPageRank: top,
      zoneDetails: zoneDetails.map((z) => ({
        ...z,
        community: Number(z.community),
        ip_count: Number(z.ip_count),
      })),
    });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, error: e.message || String(e) },
      { status: 500 }
    );
  }
}
