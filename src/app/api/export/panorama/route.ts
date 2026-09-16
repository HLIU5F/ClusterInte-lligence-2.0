import { NextRequest, NextResponse } from 'next/server';

// Known field → Chinese header mapping (covers common topology fields)
const FIELD_HEADER_MAP: Record<string, string> = {
  // 核心标识
  id: 'IP地址', ip: 'IP地址', name: '名称', label: '名称',
  service_type: '服务类型', base_role: '基础角色', role: '角色', role_guess: '推测角色',
  direction: '方向类型',
  // 安全域与网络拓扑
  zone_id: '安全域ID', zone_label: '安全域名称', community: '聚类社区编号',
  subnet_24: '子网(/24)', subnet: '子网',
  port_count: '开放端口数', ports: '端口列表',
  degree: '总连接度', in_degree: '入度(被访问)', out_degree: '出度(主动访问)',
  callers: '调用方子网', peers: '对端子网',
  // 异常与风险
  anomaly_level: '异常级别', anomaly_score: '异常评分',
  is_anomaly: '是否异常', is_critical: '是否关键资产',
  is_hub: '是否枢纽节点', is_isolated: '是否孤立节点',
  whitelisted: '是否白名单',
  // 流量
  bytes_total: '总流量(bytes)', total_traffic: '总流量', bytes_sent: '发送流量', bytes_received: '接收流量',
  // 业务属性
  owner: '负责人', environment: '环境', application: '应用', os_name: '操作系统',
};

// Fields to always exclude from export (internal/noise)
const EXCLUDE_FIELDS = new Set(['x', 'y', 'fx', 'fy', 'vx', 'vy', 'index']);

// Priority order for known fields (lower = earlier in CSV)
const FIELD_PRIORITY: Record<string, number> = {
  id: 1, ip: 1, name: 2, label: 2, service_type: 3, base_role: 4, role: 4, role_guess: 5,
  direction: 6, zone_id: 10, zone_label: 11, community: 12, subnet_24: 13, subnet: 13,
  port_count: 14, ports: 15, degree: 16, in_degree: 17, out_degree: 18,
  callers: 19, peers: 20, anomaly_level: 30, anomaly_score: 31,
  bytes_total: 40, total_traffic: 40, bytes_sent: 41, bytes_received: 42,
  owner: 50, environment: 51, application: 52, os_name: 53,
  is_anomaly: 90, is_critical: 91, is_hub: 92, is_isolated: 93, whitelisted: 94,
};

function buildColumns(sampleNodes: Record<string, any>[]): Array<{ key: string; header: string }> {
  const keySet = new Set<string>();
  for (const node of sampleNodes) {
    for (const k of Object.keys(node)) {
      if (!EXCLUDE_FIELDS.has(k)) keySet.add(k);
    }
  }
  const keys = Array.from(keySet).sort((a, b) => {
    const pa = FIELD_PRIORITY[a] ?? 500;
    const pb = FIELD_PRIORITY[b] ?? 500;
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b);
  });
  return keys.map(k => ({ key: k, header: FIELD_HEADER_MAP[k] || k }));
}

function generateCSV(nodes: Record<string, any>[], _links: any[]): { csvContent: string; rowCount: number } {
  const sanitize = (v: any): string => {
    if (v == null) return '';
    let s = String(v);
    s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    s = s.replace(/[\r\n]+/g, ' ');
    s = s.replace(/\s{2,}/g, ' ').trim();
    return s;
  };
  const esc = (v: any) => {
    const s = sanitize(v);
    return `"${s.replace(/"/g, '""')}"`;
  };

  // Dynamically build columns from actual data
  const columns = buildColumns(nodes.slice(0, 100));

  const header = columns.map(c => esc(c.header)).join(',');
  const rows: string[] = [header];
  for (const node of nodes) {
    const values = columns.map(col => {
      const v = node[col.key];
      if (Array.isArray(v)) return v.join('|');
      if (typeof v === 'boolean') return v ? '是' : '否';
      if (typeof v === 'number') return String(Number.isInteger(v) ? v : Number(v).toFixed(4));
      return String(v ?? '');
    });
    rows.push(values.map(esc).join(','));
  }
  return { csvContent: '\uFEFF' + rows.join('\r\n'), rowCount: rows.length };
}

export async function POST(request: NextRequest) {
  console.log('[EXPORT] POST /api/export/panorama called');
  try {
    const body = await request.json();
    const nodes: Record<string, any>[] = body.nodes || [];
    const links: any[] = body.links || [];
    console.log(`[EXPORT] Received ${nodes.length} nodes, ${links.length} links`);
    if (nodes.length === 0) {
      console.error('[EXPORT] No nodes provided');
      return NextResponse.json({ error: 'No topology data provided' }, { status: 400 });
    }
    const { csvContent, rowCount } = generateCSV(nodes, links);
    const filename = `资产全景_merged_${new Date().toISOString().slice(0, 10)}.csv`;
    console.log(`[EXPORT] Generated CSV: ${rowCount} rows, ${csvContent.length} bytes`);
    if (rowCount > 1) {
      console.log(`[EXPORT] Columns: ${csvContent.split('\r\n')[0].substring(0, 500)}`);
      console.log(`[EXPORT] Sample row: ${csvContent.split('\r\n')[1].substring(0, 500)}`);
    }
    return new NextResponse(csvContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('[EXPORT] POST error:', error);
    return NextResponse.json({
      error: 'Failed to generate asset panorama CSV',
      detail: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

// GET fallback: read from static file
import { readFile } from 'fs/promises';
import path from 'path';
const TOPOLOGY_FILE = path.resolve(process.cwd(), 'public', 'topology_data_security.json');
export async function GET(_request: NextRequest) {
  console.log('[EXPORT] GET /api/export/panorama called (fallback)');
  try {
    const raw = await readFile(TOPOLOGY_FILE, 'utf-8');
    const data = JSON.parse(raw);
    const nodes: Record<string, any>[] = data.nodes || [];
    const links: any[] = data.links || [];
    const { csvContent } = generateCSV(nodes, links);
    const filename = `资产全景_merged_${new Date().toISOString().slice(0, 10)}.csv`;
    return new NextResponse(csvContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('[EXPORT] GET fallback error:', error);
    return NextResponse.json({ error: 'Failed to generate CSV' }, { status: 500 });
  }
}
