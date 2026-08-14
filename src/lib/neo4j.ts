/**
 * Neo4j HTTP API 客户端（零依赖，纯 fetch）
 *
 * 不需要 neo4j-driver npm 包，直接调用 Neo4j 5.x 内置的
 * transactional HTTP endpoint:
 *   POST http://host:7474/db/neo4j/tx/commit
 *
 * 保持与旧 driver 版相同的 runCypher<T>() 接口，
 * route.ts 一行都不用改。
 */

const NEO4J_HTTP = process.env.NEO4J_HTTP_URL || 'http://localhost:7474';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || 'neo4j';
const NEO4J_DB = process.env.NEO4J_DB || 'neo4j';

function authHeader(): string {
  const token = Buffer.from(`${NEO4J_USER}:${NEO4J_PASSWORD}`).toString('base64');
  return `Basic ${token}`;
}

export async function runCypher<T = any>(
  cypher: string,
  params: Record<string, any> = {}
): Promise<T[]> {
  const url = `${NEO4J_HTTP}/db/${NEO4J_DB}/tx/commit`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader(),
    },
    body: JSON.stringify({
      statements: [
        {
          statement: cypher,
          parameters: params,
          resultDataContents: ['row'],
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Neo4j HTTP ${response.status}: ${text}`);
  }

  const body = await response.json();

  // Neo4j 把 Cypher 语法 / 运行时错误放在 errors[] 里
  if (body.errors?.length > 0) {
    const err = body.errors[0];
    throw new Error(`Neo4j Cypher error: ${err.message} (code: ${err.code})`);
  }

  // results[0].columns = ["id", "community", ...]
  // results[0].data[i].row = ["10.0.0.1", 5, ...]
  const result = body.results?.[0];
  if (!result?.data) return [];

  const columns: string[] = result.columns;
  return result.data.map((entry: any) => {
    const obj: Record<string, any> = {};
    columns.forEach((col, i) => {
      obj[col] = entry.row[i];
    });
    return obj as T;
  });
}
