import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { convertRawLogsToTopology } from '@/lib/dataConverter';

// Set body size limit for this route handler (Next.js App Router)
// This tells Next.js to allow larger request bodies for this endpoint
export const config = {
  api: {
    bodyParser: false, // Disable default body parser to handle large files
  },
};

// For App Router, we can also set maxDuration if needed
export const maxDuration = 60; // seconds

export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get('content-type') || '';
    
    let buffer: Buffer;
    
    if (contentType.includes('multipart/form-data')) {
      // Handle multipart form data (file upload)
      const formData = await request.formData();
      const file = formData.get('file') as File;
      
      if (!file) {
        return NextResponse.json({ error: 'No file provided' }, { status: 400 });
      }
      
      buffer = Buffer.from(await file.arrayBuffer());
    } else if (contentType.includes('application/octet-stream') || 
               contentType.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) {
      // Handle raw binary upload - bypasses formData parsing limits
      const arrayBuffer = await request.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
    } else {
      // Try formData as fallback
      const formData = await request.formData();
      const file = formData.get('file') as File;
      
      if (!file) {
        return NextResponse.json({ error: 'No file provided' }, { status: 400 });
      }
      
      buffer = Buffer.from(await file.arrayBuffer());
    }

    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rawData = XLSX.utils.sheet_to_json(sheet);

    if (!rawData || rawData.length === 0) {
      return NextResponse.json({ error: 'Empty file or no data rows' }, { status: 400 });
    }

    // Validate required fields
    const firstRow = rawData[0] as Record<string, unknown>;
    const requiredFields = ['src', 'dst'];
    const missingFields = requiredFields.filter(f => !(f in firstRow));
    if (missingFields.length > 0) {
      return NextResponse.json({
        error: `Missing required fields: ${missingFields.join(', ')}`,
      }, { status: 400 });
    }

    // Convert to raw logs format
    const logs = (rawData as Record<string, unknown>[]).map((row) => ({
      proto: String(row.proto || 'tcp'),
      src: String(row.src),
      dst: String(row.dst),
      dport: typeof row.dport === 'number' ? row.dport : parseInt(String(row.dport || '0'), 10),
      deviceDirection: String(row.deviceDirection || 'IN'),
      cdate: String(row.cdate || ''),
      sdate: String(row.sdate || ''),
    }));

    // Convert to topology data
    const topologyData = convertRawLogsToTopology(logs);

    return NextResponse.json({
      success: true,
      data: topologyData,
      message: `Successfully parsed ${logs.length} logs into ${topologyData.nodes.length} nodes and ${topologyData.links.length} links`,
    });
  } catch (error) {
    console.error('Import error:', error);
    return NextResponse.json({
      error: 'Failed to process file',
      detail: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}
