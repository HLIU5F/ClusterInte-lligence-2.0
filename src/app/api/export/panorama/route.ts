import { NextRequest, NextResponse } from 'next/server';

/** 精简 zone_label：过长时截取关键部分，保留可读性 */
function simplifyZoneLabel(label: string | undefined | null): string {
  if (!label || label === 'Unassigned' || label === 'default') return label || '';
  // 如果已经是简短格式（<=30字符），直接返回
  if (label.length <= 30) return label;
  // 尝试提取核心名称：取第一个有意义的片段
  const parts = label.split(/[|;,]/).map(s => s.trim()).filter(Boolean);
  if (parts.length > 1) {
    const short = parts.slice(0, 2).join(' | ');
    if (short.length <= 30) return short;
  }
  // 截断并加省略号
  return label.substring(0, 28) + '..';
}

interface TopoNode {
  id: string;
  community?: number;
  ports?: number[];
  protocols?: string[];
  anomaly_score?: number;
  anomaly_level?: string;
  role_guess?: string;
  zone_id?: string;
  zone_label?: string;
  service_type?: string;
  subnet_24?: string;
  label?: string;
  degree?: number;
  in_degree?: number;
  out_degree?: number;
  is_anomaly?: boolean;
  geo_country?: string;
  business_group?: string;
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

export async function POST(request: NextRequest) {
  console.log('[EXPORT] POST /api/export/panorama called');
  try {
    const body = await request.json();
    const nodes: TopoNode[] = body.nodes || [];
    const links: TopoLink[] = body.links || [];
    console.log(`[EXPORT] Received ${nodes.length} nodes, ${links.length} links`);

    if (nodes.length === 0) {
      console.error('[EXPORT] No nodes provided');
      return NextResponse.json({ error: 'No topology data provided' }, { status: 400 });
    }

    // Aggregate connections per node
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

    function summarize(conns: Array<{ peer: string; ports: string; proto: string }> | undefined, maxItems = 5): string {
      if (!conns || conns.length === 0) return '';
      const items = conns.slice(0, maxItems).map(c => `${c.peer}(${c.proto}:${c.ports})`);
      const suffix = conns.length > maxItems ? `+${conns.length - maxItems}more` : '';
      return items.join(';') + suffix;
    }

    const header = 'id:ID,name,type,security_domain,subnet,role_guess,zone_id,zone_label,inbound_summary,outbound_summary,inbound_count,outbound_count';
    const rows: string[] = [header];

    for (const node of nodes) {
      const inbound = inboundMap.get(node.id);
      const outbound = outboundMap.get(node.id);
      const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;

      rows.push([
        node.id,
        node.label || node.id,
        node.service_type || 'Host',
        node.business_group || 'Internal',
        node.subnet_24 || '',
        node.role_guess || '',
        node.zone_id || '',
        simplifyZoneLabel(node.zone_label),
        summarize(inbound),
        summarize(outbound),
        inbound?.length ?? 0,
        outbound?.length ?? 0,
      ].map(esc).join(','));
    }

    const csvContent = '\uFEFF' + rows.join('\r\n');
    const filename = `asset_panorama_merged_${new Date().toISOString().slice(0, 10)}.csv`;
    console.log(`[EXPORT] Generated CSV: ${rows.length} rows, ${csvContent.length} bytes`);

    // Log sample row for debugging
    if (rows.length > 1) {
      console.log(`[EXPORT] Sample row: ${rows[1].substring(0, 200)}`);
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

// GET fallback
import { readFile } from 'fs/promises';
import path from 'path';
const TOPOLOGY_FILE = path.resolve(process.cwd(), 'public', 'topology_data_security.json');

export async function GET(_request: NextRequest) {
  console.log('[EXPORT] GET /api/export/panorama called (fallback)');
  try {
    const raw = await readFile(TOPOLOGY_FILE, 'utf-8');
    const data = JSON.parse(raw);
    const nodes: TopoNode[] = data.nodes || [];
    const links: TopoLink[] = data.links || [];

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

    function summarize(conns: Array<{ peer: string; ports: string; proto: string }> | undefined, maxItems = 5): string {
      if (!conns || conns.length === 0) return '';
      const items = conns.slice(0, maxItems).map(c => `${c.peer}(${c.proto}:${c.ports})`);
      const suffix = conns.length > maxItems ? `+${conns.length - maxItems}more` : '';
      return items.join(';') + suffix;
    }

    const header = 'id:ID,name,type,security_domain,subnet,role_guess,zone_id,zone_label,inbound_summary,outbound_summary,inbound_count,outbound_count';
    const rows: string[] = [header];
    for (const node of nodes) {
      const inbound = inboundMap.get(node.id);
      const outbound = outboundMap.get(node.id);
      const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      rows.push([
        node.id, node.label || node.id, node.service_type || 'Host',
        node.business_group || 'Internal', node.subnet_24 || '',
        node.role_guess || '', node.zone_id || '', simplifyZoneLabel(node.zone_label),
        summarize(inbound), summarize(outbound),
        inbound?.length ?? 0, outbound?.length ?? 0,
      ].map(esc).join(','));
    }

    const csvContent = '\uFEFF' + rows.join('\r\n');
    const filename = `asset_panorama_merged_${new Date().toISOString().slice(0, 10)}.csv`;
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
