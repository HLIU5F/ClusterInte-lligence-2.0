/**
 * API 层统一的错误响应构造。
 *
 * 目标：前端不再只能看到一句 "Failed to load from Neo4j"。
 * 所有依赖 Neo4j 的路由都返回同一形状：
 *   { error, code, detail, hint }
 *   - code   ：机器可读（NEO4J_NOT_CONFIGURED / NEO4J_UNREACHABLE / NEO4J_QUERY_ERROR / INTERNAL_ERROR）
 *   - detail ：原始报错，便于运维定位
 *   - hint   ：给运维/用户的下一步建议
 *
 * HTTP 状态码约定：
 *   503 —— 依赖没就绪（没配密码 / 连不上 / 认证失败），前端应提示"可先用本地数据"
 *   500 —— 依赖在，但查询本身失败（Cypher 报错、缺 GDS 插件、代码 bug）
 */

import { NextResponse } from 'next/server';
import { Neo4jError, type Neo4jErrorCode } from './neo4jConfig';

interface Classified {
  code: Neo4jErrorCode;
  status: number;
  detail: string;
  hint: string;
}

interface DriverLikeError {
  name?: string;
  code?: string;
  message?: string;
}

function classify(err: unknown): Classified {
  // 1) 本项目的 HTTP 客户端错误
  if (err instanceof Neo4jError) {
    return {
      code: err.code,
      status: err.code === 'NEO4J_QUERY_ERROR' ? 500 : 503,
      detail: err.message,
      hint: err.hint,
    };
  }

  const e = err as DriverLikeError;
  const message = e?.message || String(err);

  // 2) 连接层失败：库没起 / 端口不通 / 认证失败 / TLS 不匹配
  //    neo4j-driver 把「连不上」编码成 code='ServiceUnavailable'，而它的 name 同样是 'Neo4jError'，
  //    所以这一支必须排在下面的通用 Neo4jError 分支之前，否则会被误判成 Cypher 查询错误（500）。
  if (
    e?.code === 'ServiceUnavailable' ||
    e?.code === 'SessionExpired' ||
    (typeof e.code === 'string' && e.code.startsWith('Neo.ClientError.Security')) ||
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|Connection refused|socket hang up|Failed to connect to server/i.test(message)
  ) {
    const isAuth = typeof e?.code === 'string' && e.code.startsWith('Neo.ClientError.Security');
    return {
      code: 'NEO4J_UNREACHABLE',
      status: 503,
      detail: message,
      hint: isAuth
        ? '认证失败：检查 NEO4J_USER / NEO4J_PASSWORD'
        : '确认 Neo4j 已启动、7687(Bolt) / 7474(HTTP) 端口对本机开放',
    };
  }

  // 3) 库连上了，但查询本身失败（缺 GDS 插件、Cypher 语法错等）
  if (e?.name === 'Neo4jError' && typeof e.code === 'string') {
    if (e.code.includes('Procedure')) {
      return {
        code: 'NEO4J_QUERY_ERROR',
        status: 500,
        detail: `${message} (${e.code})`,
        hint: '提示 unknown function/procedure 通常是缺 GDS 插件（neo4j-plugins/）',
      };
    }
    return {
      code: 'NEO4J_QUERY_ERROR',
      status: 500,
      detail: `${message} (${e.code})`,
      hint: '',
    };
  }

  // 4) 其余一律当内部错误
  return { code: 'INTERNAL_ERROR', status: 500, detail: message, hint: '' };
}

/**
 * 把任意异常转成统一形状的 NextResponse。
 * @param scope 日志前缀，例如 'api/topology/neo4j'
 * @param err   捕获到的异常
 * @param extra 额外合并进响应体的字段（例如 { success: false }）
 */
export function neo4jErrorResponse(
  scope: string,
  err: unknown,
  extra: Record<string, unknown> = {}
): NextResponse {
  const { code, status, detail, hint } = classify(err);

  if (code === 'INTERNAL_ERROR') {
    console.error(`[${scope}] unexpected error:`, err);
  } else {
    console.error(`[${scope}] ${code}: ${detail}`);
  }

  return NextResponse.json(
    {
      error: code === 'INTERNAL_ERROR' ? '服务内部错误' : 'Neo4j 不可用',
      code,
      detail,
      hint,
      ...extra,
    },
    { status }
  );
}

/** 供前端/日志复用的「本地数据可用」提示，避免每个路由各写一份 */
export const LOCAL_FALLBACK_HINT =
  'Neo4j 未就绪时前端仍可用：用「加载业务核心图」读本地/演示数据，GDS 按钮会自动降级为本地图算法。';
