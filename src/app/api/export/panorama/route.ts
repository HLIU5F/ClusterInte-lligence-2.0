import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import path from 'path';

interface TopoNode {
  id: string;
  community?: number;
  ports?: number[];
  protocols?: string[];
  anomaly_score?: number;
  anomaly_level?: string;
  role_guess?: string;
  base_role?: string;
  zone_id?: string;
  zone_label?: string;
  service_type?: string;
  subnet_24?: string;
  label?: string;
  degree?: number;
  in_degree?: number;
  out_degree?: number;
  port_count?: number;
  [key: string]: any;
}

interface TopoLink {
  source: string | { id: string };
  target: string | { id: string };
  ports?: number[];
  weight?: number;
  protocol?: string;
}

function getNodeId(n: string | { id: string }): string {
  return typeof n === 'string' ? n : n.id;
}

// CSV column definitions ordered by priority
// header format: "English / 中文"
const CSV_COLUMNS: Array<{ key: string; header: string }> = [
  // === Core Identity / 核心标识 ===
  { key: 'id',             header: 'IP Address / IP地址' },
  { key: 'label',          header: 'Label / 名称' },
  { key: 'service_type',   header: 'Service Type / 服务类型' },
  { key: 'base_role',      header: 'Base Role / 基础角色' },
  { key: 'role_guess',     header: 'Guessed Role / 推测角色' },
  // === Security Zone & Topology / 安全域与拓扑 ===
  { key: 'zone_id',        header: 'Zone ID / 安全域ID' },
  { key: 'zone_label',     header: 'Zone Label / 安全域名称' },
  { key: 'community',      header: 'Community / 社区编号' },
  { key: 'subnet_24',      header: 'Subnet(/24) / 子网' },
  { key: 'port_count',     header: 'Open Ports Count / 开放端口数' },
  { key: 'ports',          header: 'Port List / 端口列表' },
  { key: 'degree',         header: 'Degree / 总连接度' },
  { key: 'in_degree',      header: 'In-Degree / 入度' },
  { key: 'out_degree',     header: 'Out-Degree / 出度' },
  // === Anomaly / 异常 ===
  { key: 'anomaly_level',  header: 'Anomaly Level / 异常级别' },
  { key: 'anomaly_score',  header: 'Anomaly Score / 异常评分' },
  // === Connection Summary (aggregated from links) / 连接摘要 ===
  { key: 'inbound_summary',  header: 'Inbound Summary / 入向连接摘要' },
  { key: 'outbound_summary', header: 'Outbound Summary / 出向连接摘要' },
  { key: 'inbound_count',    header: 'Inbound Count / 入向连接数' },
  { key: 'outbound_count',   header: 'Outbound Count / 出向连接数' },
];

function buildConnectionMaps(links: TopoLink[]) {
  const inboundMap = new Map<string, Array<{ peer: string; ports: string; proto: string }>>();
  const outboundMap = new Map<string, Array<{ peer: string; ports: string; proto: string }>>();
  for (const link of links) {
    const src = getNodeId(link.source);
    const dst = getNodeId(link.target);
    const ports = (link.ports || []).join(';') || '*';
    const proto = link.protocol || 'tcp';
    if (!outboundMap.has(src)) outboundMap.set(src, []);
    outboundMap.get(src)!.push({ peer: dst, ports, proto });
    if (!inboundMap.has(dst)) inboundMap.set(dst, []);
    inboundMap.get(dst)!.push({ peer: src, ports, proto });
  }
  return { inboundMap, outboundMap };
}

function summarize(conns: Array<{ peer: string; ports: string; proto: string }> | undefined, maxItems = 5): string {
  if (!conns || conns.length === 0) return '';
  const items = conns.slice(0, maxItems).map(c => `${c.peer}(${c.proto}:${c.ports})`);
  const suffix = conns.length > maxItems ? `+${conns.length - maxItems}more` : '';
  return items.join(';') + suffix;
}

function generateCSV(nodes: TopoNode[], links: TopoLink[]): { csvContent: string; rowCount: number } {
  const { inboundMap, outboundMap } = buildConnectionMaps(links);
  const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  // Pre-compute all row values
  const allValues: string[][] = [];
  for (const node of nodes) {
    const inbound = inboundMap.get(node.id);
    const outbound = outboundMap.get(node.id);
    const values = CSV_COLUMNS.map(col => {
      switch (col.key) {
        case 'anomaly_score':    return String(Number(node.anomaly_score ?? 0).toFixed(4));
        case 'ports':            return Array.isArray(node.ports) ? node.ports.join('|') : '';
        case 'port_count':       return String(node.port_count ?? (Array.isArray(node.ports) ? node.ports.length : 0));
        case 'community':        return String(node.community ?? '');
        case 'degree':           return String(node.degree ?? 0);
        case 'in_degree':        return String(node.in_degree ?? 0);
        case 'out_degree':       return String(node.out_degree ?? 0);
        case 'inbound_summary':  return summarize(inbound);
        case 'outbound_summary': return summarize(outbound);
        case 'inbound_count':    return String(inbound?.length ?? 0);
        case 'outbound_count':   return String(outbound?.length ?? 0);
        default:                 return String((node as any)[col.key] ?? '');
      }
    });
    allValues.push(values);
  }
  // Filter out columns where every row is empty or zero
  const nonEmptyColIndices = CSV_COLUMNS.map((_, i) => i).filter(i =>
    allValues.some(row => row[i] !== '')
  );
  const header = nonEmptyColIndices.map(i => esc(CSV_COLUMNS[i].header)).join(',');
  const rows: string[] = [header];
  for (const values of allValues) {
    rows.push(nonEmptyColIndices.map(i => values[i]).map(esc).join(','));
  }
  return { csvContent: '\uFEFF' + rows.join('\r\n'), rowCount: rows.length };
}

const TOPOLOGY_FILE = path.resolve(process.cwd(), 'public', 'topology_data_security.json');

// POST: accept nodes/links from frontend
export async function POST(request: NextRequest) {
  console.log('[EXPORT] POST /api/export/panorama called');
  try {
    const body = await request.json();
    let nodes: TopoNode[] = body.nodes || [];
    const links: TopoLink[] = body.links || [];
    console.log(`[EXPORT] Received ${nodes.length} nodes, ${links.length} links`);

    // If frontend sends empty or minimal nodes, fallback to static file
    if (nodes.length === 0) {
      console.log('[EXPORT] No nodes in POST body, falling back to static file');
      const raw = await readFile(TOPOLOGY_FILE, 'utf-8');
      const data = JSON.parse(raw);
      nodes = data.nodes || [];
    }

    const { csvContent, rowCount } = generateCSV(nodes, links);
    const filename = `Asset_Panorama_${new Date().toISOString().slice(0, 10)}.csv`;
    console.log(`[EXPORT] Generated CSV: ${rowCount} rows, ${csvContent.length} bytes`);

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

// GET: read from static file directly
export async function GET(_request: NextRequest) {
  console.log('[EXPORT] GET /api/export/panorama called');
  try {
    const raw = await readFile(TOPOLOGY_FILE, 'utf-8');
    const data = JSON.parse(raw);
    const nodes: TopoNode[] = data.nodes || [];
    const links: TopoLink[] = data.links || [];
    const { csvContent } = generateCSV(nodes, links);
    const filename = `Asset_Panorama_${new Date().toISOString().slice(0, 10)}.csv`;
    return new NextResponse(csvContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('[EXPORT] GET error:', error);
    return NextResponse.json({ error: 'Failed to generate CSV' }, { status: 500 });
  }
}
