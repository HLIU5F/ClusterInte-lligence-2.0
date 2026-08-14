// src/app/api/enrich/route.ts
// POST /api/enrich - 对单个 IP 执行 enricher
// GET /api/enrich - 列出可用 enricher

import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);

// Python 解释器路径（优先用项目内的 venv，回退到系统 python3）
const PYTHON_BIN = process.env.PYTHON_BIN || 'python';

// 项目根目录（向上查找 scripts 目录）
const PROJECT_ROOT = process.cwd();
const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'enrich_single_ip.py');

// 超时设置（enricher 可能涉及外部 API 调用）
const TIMEOUT_MS = 30_000;

/**
 * GET /api/enrich
 * 列出所有可用 enricher
 */
export async function GET() {
  try {
    const { stdout } = await execFileAsync(
      PYTHON_BIN,
      [SCRIPT_PATH, '--list'],
      { timeout: 10_000, cwd: PROJECT_ROOT, encoding: 'utf-8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }
    );
    const result = JSON.parse(stdout);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Failed to list enrichers:', error);
    return NextResponse.json(
      { error: '无法列出 enricher', detail: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/enrich
 * Body: { ip: string, enricher?: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { ip, enricher, node } = body;

    // 参数校验
    if (!ip || typeof ip !== 'string') {
      return NextResponse.json(
        { error: '缺少 ip 参数', ip: null, enriched: false },
        { status: 400 }
      );
    }

    // 简单 IP 格式校验
    const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipv4Pattern.test(ip)) {
      return NextResponse.json(
        { error: `无效 IP 格式: ${ip}`, ip, enriched: false },
        { status: 400 }
      );
    }

    // 构造 Python 命令参数
    const args = [SCRIPT_PATH, '--ip', ip];
    if (enricher) {
      args.push('--enricher', enricher);
    }
    if (node && typeof node === 'object') {
      args.push('--node-json', JSON.stringify(node));
    }

    // 执行 Python 脚本
    const { stdout } = await execFileAsync(
      PYTHON_BIN,
      args,
      { timeout: TIMEOUT_MS, cwd: PROJECT_ROOT, encoding: 'utf-8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }
    );

    const result = JSON.parse(stdout);

    // 如果 enricher 返回了 errors，HTTP 仍返回 200，但在 body 中标注
    return NextResponse.json(result);
  } catch (error) {
    console.error('Enrich error:', error);

    // Python 脚本超时
    if (error && typeof error === 'object' && 'killed' in error && (error as any).killed) {
      return NextResponse.json(
        { error: 'Enricher 执行超时', enriched: false },
        { status: 504 }
      );
    }

    return NextResponse.json(
      { error: 'Enricher 执行失败', detail: error instanceof Error ? error.message : 'Unknown', enriched: false },
      { status: 500 }
    );
  }
}
