/**
 * Neo4j 连接配置的单一来源（single source of truth）。
 *
 * 项目里有两条访问 Neo4j 的通道，历史上各自读不同的环境变量，云服务器上
 * 少配一个就会出现"一半接口 500"的假故障：
 *
 *   1. HTTP 事务端点（零依赖 fetch）—— src/lib/neo4j.ts
 *      /api/topology/neo4j、/api/topology/gds、/api/analysis/gds
 *      旧变量：NEO4J_HTTP_URL / NEO4J_DB
 *   2. Bolt 驱动（neo4j-driver）—— /api/analysis/path、/api/analysis/neighbors
 *      旧变量：NEO4J_URI / NEO4J_DATABASE
 *
 * 现在统一在这里解析：只要配了 NEO4J_URI，HTTP 地址会自动推导；
 * NEO4J_DB 与 NEO4J_DATABASE 互为兜底（两个键都保留，兼容既有 .env.local）。
 */

/** 机器可读的失败原因，路由据此决定 HTTP 状态码，前端据此决定提示与降级策略 */
export type Neo4jErrorCode =
  | 'NEO4J_NOT_CONFIGURED'
  | 'NEO4J_UNREACHABLE'
  | 'NEO4J_QUERY_ERROR'
  | 'INTERNAL_ERROR';

export class Neo4jError extends Error {
  readonly code: Neo4jErrorCode;
  readonly hint: string;

  constructor(code: Neo4jErrorCode, message: string, hint = '') {
    super(message);
    this.name = 'Neo4jError';
    this.code = code;
    this.hint = hint;
  }
}

/** HTTP 接口风格：auto = 优先新版 Query API，404 时回退旧事务端点 */
export type Neo4jHttpApi = 'auto' | 'query' | 'tx';

export interface Neo4jConfig {
  user: string;
  password: string;
  database: string;
  /** Bolt 地址，neo4j-driver 使用 */
  boltUri: string;
  /** HTTP 端点根地址（不含 /db/... 路径），fetch 客户端使用 */
  httpUrl: string;
  timeoutMs: number;
  /** HTTP 接口风格，来自 NEO4J_HTTP_API（默认 auto） */
  httpApi: Neo4jHttpApi;
}

/**
 * bolt://host:7687 → http://host:7474
 *
 * Neo4j 默认端口配对：7687(Bolt) / 7474(HTTP)，7688(Bolt) / 7475(HTTP)。
 * 加密变体（bolt+s / neo4j+s / bolt+ssc / neo4j+ssc）对应 https。
 * 非默认端口原样保留（例如反代到 443），必要时用 NEO4J_HTTP_URL 显式覆盖。
 */
export function deriveHttpUrl(boltUri: string): string {
  const fallback = 'http://localhost:7474';
  const raw = (boltUri || '').trim();
  if (!raw) return fallback;

  const match = /^(bolt|neo4j)(\+s|\+ssc)?:\/\/(.+)$/i.exec(raw);
  if (!match) return fallback;

  const secure = Boolean(match[2]);
  const authority = match[3];

  const portMap: Record<string, string> = { '7687': '7474', '7688': '7475' };
  const withMappedPort = authority.replace(/:(\d+)(?=\/|$)/, (whole, port: string) => {
    const mapped = portMap[port];
    return mapped ? `:${mapped}` : whole;
  });

  return `${secure ? 'https' : 'http'}://${withMappedPort}`;
}

/** 当前进程可见的 Neo4j 配置（每次调用重新读 env，便于运行时改环境变量） */
function normalizeHttpApi(value: string | undefined): Neo4jHttpApi {
  const v = (value || '').trim().toLowerCase();
  return v === 'query' || v === 'tx' ? v : 'auto';
}

/** 当前进程可见的 Neo4j 配置（每次调用重新读 env，便于运行时改环境变量） */
export function readNeo4jConfig(): Neo4jConfig {
  const boltUri = process.env.NEO4J_URI || 'bolt://localhost:7687';
  const timeout = Number(process.env.NEO4J_TIMEOUT_MS);

  return {
    user: process.env.NEO4J_USER || 'neo4j',
    password: process.env.NEO4J_PASSWORD || '',
    database: process.env.NEO4J_DB || process.env.NEO4J_DATABASE || 'neo4j',
    boltUri,
    httpUrl: (process.env.NEO4J_HTTP_URL || deriveHttpUrl(boltUri)).replace(/\/+$/, ''),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 8000,
    httpApi: normalizeHttpApi(process.env.NEO4J_HTTP_API),
  };
}

/** 缺哪些必填项（供 /api/health 与启动期提示使用） */
export function missingNeo4jSettings(): string[] {
  const missing: string[] = [];
  if (!process.env.NEO4J_PASSWORD) missing.push('NEO4J_PASSWORD');
  return missing;
}
