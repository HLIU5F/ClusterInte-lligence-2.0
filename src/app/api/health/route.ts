/**
 * GET /api/health —— 部署自检端点
 *
 * 把「前端打得开、但后端连不上库」这类问题一次性说清楚。
 * 云服务器上先访问这个地址，再决定要不要去装 Neo4j。
 *
 * 用法：
 *   curl -s localhost:5000/api/health
 *   curl -s "localhost:5000/api/health?deep=1"   # 额外统计 IP / CONNECTS_TO 数量
 *
 * 语义：应用进程本身活着就返回 200；Neo4j 不可用只标记 degraded，不返回 5xx，
 * 这样前端与其它探针能区分「进程挂了」和「依赖没连上」。
 */

import { NextResponse } from 'next/server';
import { existsSync } from 'fs';
import path from 'path';
import { probeNeo4j, runCypher } from '@/lib/neo4j';
import { LOCAL_FALLBACK_HINT } from '@/lib/apiErrors';
import { missingNeo4jSettings, readNeo4jConfig } from '@/lib/neo4jConfig';
import { readBuildStamp } from '@/lib/buildStamp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 前端会按顺序尝试的数据文件（真实数据不入库，服务器上可能缺失） */
const DATA_FILES = [
  'topology_data_core.json',
  'topology_data_security.json',
  'security_zones_export.csv',
  'topology_demo.json',
];

export async function GET(request: Request) {
  const deep = new URL(request.url).searchParams.get('deep') === '1';
  const cfg = readNeo4jConfig();

  const neo4j = await probeNeo4j();

  let counts: {
    ips: number;
    links: number;
    /** 有 anomaly_score 属性的 IP 数 —— 0 表示这批数据没带异常标注 */
    anomaly_labeled: number;
    /** is_anomaly=true 的 IP 数 —— 前端红色光圈就是由它决定的 */
    anomaly_flagged: number;
  } | null = null;
  if (deep && neo4j.ok) {
    try {
      const ipRows = await runCypher<{ n: number }>('MATCH (n:IP) RETURN count(n) AS n');
      const linkRows = await runCypher<{ n: number }>(
        'MATCH ()-[r:CONNECTS_TO]->() RETURN count(r) AS n'
      );
      // 这两行是「满屏红色光圈」的判定依据：
      // labeled 就应该等于 ips；flagged 应等于数据文件里 is_anomaly 的个数（new2.0 为 0）。
      const anomalyRows = await runCypher<{ labeled: number; flagged: number }>(
        `MATCH (n:IP)
         RETURN count(CASE WHEN n.anomaly_score IS NOT NULL THEN 1 END) AS labeled,
                count(CASE WHEN n.is_anomaly = true THEN 1 END) AS flagged`
      );
      counts = {
        ips: Number(ipRows[0]?.n ?? 0),
        links: Number(linkRows[0]?.n ?? 0),
        anomaly_labeled: Number(anomalyRows[0]?.labeled ?? 0),
        anomaly_flagged: Number(anomalyRows[0]?.flagged ?? 0),
      };
    } catch {
      counts = null;
    }
  }

  const dataFiles = DATA_FILES.map((name) => ({
    name,
    present: existsSync(path.resolve(process.cwd(), 'public', name)),
  }));

  return NextResponse.json({
    status: neo4j.ok ? 'ok' : 'degraded',
    checked_at: new Date().toISOString(),
    // 版本自检：这四个字段是「线上到底跑没跑新代码」的唯一权威答案，
    // 不要再靠 grep 源码或几百字节的 route.js loader 去推断。
    build: readBuildStamp(),
    app: {
      node: process.version,
      env: process.env.COZE_PROJECT_ENV || 'development',
      port: process.env.PORT || '5000',
    },
    neo4j: {
      ok: neo4j.ok,
      code: neo4j.code ?? null,
      error: neo4j.error ?? null,
      hint: neo4j.hint ?? null,
      // 只回显非敏感的连接参数，绝不回显密码
      bolt_uri: cfg.boltUri,
      http_url: cfg.httpUrl,
      database: cfg.database,
      user: cfg.user,
      timeout_ms: cfg.timeoutMs,
      missing_settings: missingNeo4jSettings(),
      counts,
    },
    python: {
      // 只报配置，不真的拉起解释器，避免健康检查本身变慢或挂住
      bin: process.env.PYTHON_BIN || 'python3',
      note: 'Enricher 管道依赖该解释器与 scripts/requirements.txt；实际可用性以 /api/enrich 为准',
    },
    data_files: dataFiles,
    hints: neo4j.ok
      ? []
      : [LOCAL_FALLBACK_HINT, '接入图数据库请看 docs/云服务器部署与Neo4j接入.md。'],
  });
}
