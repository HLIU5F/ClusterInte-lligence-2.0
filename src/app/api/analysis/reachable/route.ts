/**
 * POST /api/analysis/reachable —— 横向可达性分析
 *
 * 从指定 IP 出发，在 CONNECTS_TO 图上做有界 BFS，找出 N 跳内可达的节点，
 * 并按**资产价值**排序返回 Top N —— 回答「这台机器一旦被拿下，下一步能摸到哪些高价值资产」。
 *
 * 这是纯图数据库能力：需要全量图（本库 3358 节点 / 23741 边），
 * 浏览器里只加载了一部分渲染节点时算不出正确结果。
 *
 * body:
 *   { source: string, maxHops?: 1|2|3, topN?: number, minAssetValue?: number }
 *
 * 返回:
 *   { success, source, maxHops, sourceDomain,
 *     reached,                       // 可达节点总数（不含自身）
 *     byHop: [{hops, nodes}],        // 每一跳的可达数量
 *     targets: ReachTarget[],        // 按资产价值降序的 Top N
 *     highValueReached }             // 资产价值 >= minAssetValue 的可达数
 *
 * 性能：maxHops 上限 3。变量长路径会枚举路径，3 跳在本库约数千条，可接受；
 * 4 跳以上会指数膨胀，因此强制截断。
 */

import { NextResponse } from 'next/server';
import { neo4jErrorResponse } from '@/lib/apiErrors';
import { runCypher } from '@/lib/neo4j';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_HOPS_LIMIT = 3;

interface HopRecord {
  hops: number;
  nodes: number;
}

interface TargetRecord {
  id: string;
  hops: number;
  asset_value: number | null;
  zone_id: string | null;
  zone_label: string | null;
  security_domain: string | null;
  role_guess: string | null;
  degree: number | null;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as {
      source?: string;
      maxHops?: number;
      topN?: number;
      minAssetValue?: number;
    } | null;

    if (!body || typeof body !== 'object' || !body.source) {
      return NextResponse.json({ success: false, error: '需要提供 source IP' }, { status: 400 });
    }

    const source = String(body.source);
    const rawHops = Number(body.maxHops ?? 2);
    const maxHops = Math.min(Math.max(Number.isFinite(rawHops) ? Math.floor(rawHops) : 2, 1), MAX_HOPS_LIMIT);
    const rawTopN = Number(body.topN ?? 20);
    const topN = Math.min(Math.max(Number.isFinite(rawTopN) ? Math.floor(rawTopN) : 20, 1), 200);
    const rawMin = Number(body.minAssetValue ?? 0);
    const minAssetValue = Number.isFinite(rawMin) ? rawMin : 0;

    // 源节点自身信息（域用于标出「跨域可达」）
    const sourceRows = await runCypher<{
      zone_id: string | null;
      security_domain: string | null;
      asset_value: number | null;
    }>(
      `MATCH (ip:IP {id: $source})
       RETURN coalesce(ip.zone_id, ip.security_domain) AS zone_id,
              ip.security_domain AS security_domain,
              ip.asset_value AS asset_value`,
      { source }
    );

    if (sourceRows.length === 0) {
      return NextResponse.json(
        { success: false, error: `库里没有这个 IP：${source}` },
        { status: 404 }
      );
    }

    const srcZone = sourceRows[0].zone_id ?? null;

    // 每一跳的可达数量
    const byHop = await runCypher<HopRecord>(
      `MATCH p = (src:IP {id: $source})-[:CONNECTS_TO*1..${maxHops}]-(t:IP)
       WHERE t.id <> $source
       WITH t, min(length(p)) AS hops
       RETURN hops, count(*) AS nodes
       ORDER BY hops`,
      { source }
    );

    // 可达节点按资产价值排序取 Top N
    const targets = await runCypher<TargetRecord>(
      `MATCH p = (src:IP {id: $source})-[:CONNECTS_TO*1..${maxHops}]-(t:IP)
       WHERE t.id <> $source
       WITH t, min(length(p)) AS hops
       RETURN t.id AS id, hops,
              coalesce(t.asset_value, 0) AS asset_value,
              t.zone_id AS zone_id,
              t.zone_label AS zone_label,
              t.security_domain AS security_domain,
              t.role_guess AS role_guess,
              coalesce(t.degree, 0) AS degree
       ORDER BY asset_value DESC, hops ASC
       LIMIT ${topN}`,
      { source }
    );

    // 高价值可达数量（单独 count，避免被 Top N 截断）
    const highValueRows = await runCypher<{ c: number }>(
      `MATCH p = (src:IP {id: $source})-[:CONNECTS_TO*1..${maxHops}]-(t:IP)
       WHERE t.id <> $source AND coalesce(t.asset_value, 0) >= $minAssetValue
       RETURN count(DISTINCT t) AS c`,
      { source, minAssetValue }
    );

    const reached = byHop.reduce((sum, r) => sum + Number(r.nodes), 0);

    return NextResponse.json({
      success: true,
      source,
      maxHops,
      sourceZone: srcZone,
      sourceAssetValue: Number(sourceRows[0].asset_value ?? 0),
      reached,
      byHop: byHop.map(r => ({ hops: Number(r.hops), nodes: Number(r.nodes) })),
      highValueReached: Number(highValueRows[0]?.c ?? 0),
      minAssetValue,
      targets: targets.map(t => ({
        id: t.id,
        hops: Number(t.hops),
        assetValue: Number(t.asset_value ?? 0),
        zoneId: t.zone_id ?? t.security_domain ?? null,
        zoneLabel: t.zone_label ?? null,
        role: t.role_guess ?? null,
        degree: Number(t.degree ?? 0),
        isCrossDomain: srcZone != null && (t.zone_id ?? t.security_domain ?? null) !== srcZone,
      })),
    });
  } catch (err) {
    return neo4jErrorResponse('api/analysis/reachable', err, { success: false });
  }
}
