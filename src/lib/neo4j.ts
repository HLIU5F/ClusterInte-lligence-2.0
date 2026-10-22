/**
 * Neo4j HTTP 客户端（零依赖，纯 fetch）
 *
 * 默认走新版 **Query API**：
 *   POST <NEO4J_HTTP_URL>/db/<database>/query/v2
 *   成功 → HTTP 202 + { data: { fields, values } }
 *   失败 → HTTP 4xx + { errors: [{ code, message }] }（详情与旧端点同样完整）
 *
 * 旧事务端点 POST /db/<database>/tx/commit 在 Neo4j 2026.06 已被官方标记废弃
 * （Neo.ClientNotification.Request.FeatureDeprecationWarning:
 *   "HTTP API is deprecated. It is replaced by Query API."），但仍可用，
 * 因此保留为**自动回退**：新版返回 404（老版本 Neo4j 没有 query/v2）时切到旧端点并记住选择。
 * 可用 NEO4J_HTTP_API=query|tx|auto 强制指定（默认 auto）。
 *
 * 连接参数统一来自 src/lib/neo4jConfig.ts（只配 NEO4J_URI 时会自动推导 HTTP 地址）。
 * 失败时抛出带 code 的 Neo4jError，路由层用 neo4jErrorResponse() 转成机器可读响应。
 */

import {
  Neo4jError,
  type Neo4jConfig,
  type Neo4jErrorCode,
  readNeo4jConfig,
} from './neo4jConfig';

export { Neo4jError } from './neo4jConfig';
export type { Neo4jErrorCode } from './neo4jConfig';

type ApiFlavor = 'query' | 'tx';

interface Neo4jErrorBody {
  code?: string;
  message?: string;
}

interface Neo4jHttpBody {
  /** Query API v2 */
  data?: { fields?: string[]; values?: unknown[][] };
  /** 旧事务端点 */
  results?: Array<{ columns?: string[]; data?: Array<{ row: unknown[] }> }>;
  /** 两者共用 */
  errors?: Neo4jErrorBody[];
}

/** 记住自动探测到的接口风格，避免每次请求都多打一次 404 */
let cachedFlavor: ApiFlavor | null = null;

function endpoint(cfg: Neo4jConfig, flavor: ApiFlavor): string {
  return flavor === 'query'
    ? `${cfg.httpUrl}/db/${cfg.database}/query/v2`
    : `${cfg.httpUrl}/db/${cfg.database}/tx/commit`;
}

function requestBody(flavor: ApiFlavor, cypher: string, params: Record<string, unknown>): string {
  return flavor === 'query'
    ? JSON.stringify({ statement: cypher, parameters: params })
    : JSON.stringify({
        statements: [{ statement: cypher, parameters: params, resultDataContents: ['row'] }],
      });
}

/** 把两种响应统一成 { columns, rows }（列式 → 行式） */
function extractRows(
  body: Neo4jHttpBody,
  flavor: ApiFlavor
): { columns: string[]; rows: unknown[][] } {
  if (flavor === 'query') {
    const values = body.data?.values;
    if (!values) return { columns: [], rows: [] };
    return { columns: body.data?.fields ?? [], rows: values };
  }
  const result = body.results?.[0];
  if (!result?.data) return { columns: [], rows: [] };
  return { columns: result.columns ?? [], rows: result.data.map((entry) => entry.row) };
}

/** 依据 Neo4j 返回的 errors[] / HTTP 状态构造带 hint 的 Neo4jError */
function toNeo4jError(
  errors: Neo4jErrorBody[] | undefined,
  status: number,
  cfg: Neo4jConfig
): Neo4jError {
  const first = errors?.[0];

  if (first) {
    const code = first.code ?? '';
    const message = first.message ?? '未知错误';

    if (code.startsWith('Neo.ClientError.Security')) {
      return new Neo4jError(
        'NEO4J_UNREACHABLE',
        `${code}: ${message}`,
        '认证失败：确认 .env.local 的 NEO4J_PASSWORD 与该实例一致（可在 Neo4j Browser 里用 ALTER CURRENT USER SET PASSWORD 对齐）'
      );
    }
    if (code.includes('Procedure') || /Unknown function/i.test(message)) {
      return new Neo4jError(
        'NEO4J_QUERY_ERROR',
        `${code}: ${message}`,
        '提示 unknown function/procedure 通常是缺 GDS 插件（见 docs/云服务器部署与Neo4j接入.md 第 6.2 节）'
      );
    }
    return new Neo4jError('NEO4J_QUERY_ERROR', `${code}: ${message}`);
  }

  // 没有 errors[] —— 纯传输层问题
  if (status === 401 || status === 403) {
    return new Neo4jError(
      'NEO4J_UNREACHABLE',
      `Neo4j HTTP ${status}（未返回错误详情）`,
      '认证失败：检查 NEO4J_USER / NEO4J_PASSWORD'
    );
  }
  if (status === 429) {
    return new Neo4jError(
      'NEO4J_UNREACHABLE',
      'Neo4j HTTP 429（认证失败限流）',
      '认证失败次数过多，已被 Neo4j 限流（默认需等待约 5 秒）。确认密码后重试，反复失败会延长锁定'
    );
  }
  if (status === 404) {
    return new Neo4jError(
      'NEO4J_QUERY_ERROR',
      'Neo4j HTTP 404',
      `数据库或接口不可用：检查 NEO4J_DB / NEO4J_DATABASE（当前为 ${cfg.database}）`
    );
  }
  return new Neo4jError('NEO4J_QUERY_ERROR', `Neo4j HTTP ${status}`);
}

async function callApi<T>(
  flavor: ApiFlavor,
  cypher: string,
  params: Record<string, unknown>,
  cfg: Neo4jConfig
): Promise<T[]> {
  const url = endpoint(cfg, flavor);
  let response: Response;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64')}`,
      },
      body: requestBody(flavor, cypher, params),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const timedOut =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new Neo4jError(
      'NEO4J_UNREACHABLE',
      timedOut
        ? `连接 Neo4j 超时（>${cfg.timeoutMs}ms）：${url}`
        : `无法连接 Neo4j：${url}（${reason}）`,
      '确认 Neo4j 已启动、7474 端口对本机开放，且 .env.local 里的 NEO4J_HTTP_URL / NEO4J_URI 正确'
    );
  }

  // Query API 用 4xx 表达 Cypher 错误；旧事务端点用 200 + errors[]。统一在这里解析，
  // 所以必须**先读 body 再判断状态码**，否则会把查询错误误报成传输错误。
  const body = (await response.json().catch(() => null)) as Neo4jHttpBody | null;
  const errors = body?.errors;

  if (errors && errors.length > 0) throw toNeo4jError(errors, response.status, cfg);
  if (!response.ok) throw toNeo4jError(undefined, response.status, cfg);
  if (!body) {
    throw new Neo4jError(
      'NEO4J_QUERY_ERROR',
      `Neo4j 返回了非 JSON 响应（HTTP ${response.status}）`
    );
  }

  const { columns, rows } = extractRows(body, flavor);
  return rows.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj as T;
  });
}

export async function runCypher<T = Record<string, unknown>>(
  cypher: string,
  params: Record<string, unknown> = {}
): Promise<T[]> {
  const cfg = readNeo4jConfig();

  if (!cfg.password) {
    throw new Neo4jError(
      'NEO4J_NOT_CONFIGURED',
      '缺少 NEO4J_PASSWORD：请在项目根目录 .env.local 中配置 Neo4j 密码',
      '云服务器上可先执行 bash scripts/server_migrate.sh prepare 生成 .env.local 模板'
    );
  }

  // 显式指定时只用那一种，不做探测
  if (cfg.httpApi === 'query') return callApi<T>('query', cypher, params, cfg);
  if (cfg.httpApi === 'tx') return callApi<T>('tx', cypher, params, cfg);

  // auto：优先新版 Query API；端点不存在时回退旧事务端点并记住
  const preferred: ApiFlavor = cachedFlavor ?? 'query';
  try {
    const rows = await callApi<T>(preferred, cypher, params, cfg);
    cachedFlavor = preferred;
    return rows;
  } catch (err) {
    const looksLikeMissingEndpoint =
      preferred === 'query' &&
      err instanceof Neo4jError &&
      (/\b404\b/.test(err.message) || /not found/i.test(err.message));

    if (!looksLikeMissingEndpoint) throw err;

    const rows = await callApi<T>('tx', cypher, params, cfg);
    cachedFlavor = 'tx';
    console.warn(
      '[neo4j] 新版 Query API (/db/*/query/v2) 不可用，已回退到旧事务端点 /db/*/tx/commit'
    );
    return rows;
  }
}

export interface Neo4jProbeResult {
  ok: boolean;
  code?: Neo4jErrorCode;
  error?: string;
  hint?: string;
}

/** 轻量连通性探测：给 /api/health 用，不抛异常 */
export async function probeNeo4j(): Promise<Neo4jProbeResult> {
  try {
    await runCypher('RETURN 1 AS ok');
    return { ok: true };
  } catch (err) {
    if (err instanceof Neo4jError) {
      return { ok: false, code: err.code, error: err.message, hint: err.hint };
    }
    return {
      ok: false,
      code: 'NEO4J_UNREACHABLE',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
