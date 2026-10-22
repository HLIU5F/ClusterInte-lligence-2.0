// src/lib/buildStamp.ts
//
// 「线上跑的到底是哪一版」自检。
//
// 背景：云服务器内存不够跑 `next build`，产物是本地构建后整包上传的。
// 一旦上传的 .next 是旧的、或者 pm2 还挂着老进程，就会出现
// 「本地明明修好了，线上还是老样子」。而这个问题**光看代码看不出来**：
// Turbopack 产物里 .next/server/app/api/.../route.js 只有 431 字节的 loader，
// 真正的逻辑在 .next/server/chunks/*.js 里，grep 错文件就会得出「代码是旧的」的假结论。
//
// 所以把「代码签名」直接做进接口返回值里，用运行时事实说话：
//   curl -s localhost:5000/api/health | grep -E 'code_version|build_id'
//   curl -s localhost:5000/api/topology/neo4j | ... anomaly_source_counts
//
// code_version 对得上 = 跑的是新代码；对不上 = 没同步上（旧 .next 或旧进程）。

import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';

/**
 * 代码签名：凡是会改变「接口返回值 / 前端渲染结果」的改动，就把它 +1。
 * 这样线上 curl 一下就知道新代码有没有真的生效。
 */
export const CODE_VERSION = 'v2-stored-anomaly';

/**
 * 异常标注来源判定逻辑的版本。
 * stored-first = 「数据自带的 is_anomaly / anomaly_score 优先，缺字段才跑启发式」。
 * 老版本是无条件跑启发式，会把一份完全没有异常标注的数据渲染成满屏红色光圈。
 */
export const ANOMALY_SOURCE_VERSION = 'stored-first';

export interface BuildStamp {
  code_version: string;
  anomaly_source_version: string;
  /** .next/BUILD_ID —— 每次 next build 都会变，用来判断产物是不是这一版 */
  build_id: string | null;
  /** BUILD_ID 文件的 mtime（≈ 构建时间，ISO 字符串） */
  built_at: string | null;
  /** 进程工作目录：pm2 cwd 配错时一眼就能看出来 */
  cwd: string;
}

let cached: BuildStamp | null = null;

/** 读一次就缓存。产物目录在进程生命周期内不会变，健康检查不该反复碰磁盘。 */
export function readBuildStamp(): BuildStamp {
  if (cached) return cached;

  const cwd = process.cwd();
  let build_id: string | null = null;
  let built_at: string | null = null;
  try {
    const idFile = path.resolve(cwd, '.next', 'BUILD_ID');
    if (existsSync(idFile)) {
      build_id = readFileSync(idFile, 'utf8').trim() || null;
      built_at = statSync(idFile).mtime.toISOString();
    }
  } catch {
    // 读不到就保持 null —— 健康检查本身不能因为读一个文件而失败
  }

  cached = {
    code_version: CODE_VERSION,
    anomaly_source_version: ANOMALY_SOURCE_VERSION,
    build_id,
    built_at,
    cwd,
  };
  return cached;
}
