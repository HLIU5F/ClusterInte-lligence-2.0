import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import path from 'path';

const SCRIPT_PATH = path.resolve(process.cwd(), '..', 'deploy-package', 'scripts', 'merge_to_single.py');
const DATA_DIR = '/root/cleaned_data/export_topology_for_anchor';
const OUTPUT_FILE = path.join(DATA_DIR, 'asset_panorama_merged.csv');

export async function GET(_request: NextRequest) {
  try {
    // Execute merge script with explicit working directory
    await new Promise<void>((resolve, reject) => {
      execFile('python3', [SCRIPT_PATH], { cwd: DATA_DIR, timeout: 60000 }, (error, stdout, stderr) => {
        if (error) {
          console.error('merge_to_single.py failed:', stderr || error.message);
          reject(new Error(stderr || error.message));
        } else {
          console.log('merge_to_single.py output:', stdout.trim());
          resolve();
        }
      });
    });

    // Read generated CSV
    const csvBuffer = await readFile(OUTPUT_FILE);
    const filename = `asset_panorama_merged_${new Date().toISOString().slice(0, 10)}.csv`;

    return new NextResponse(csvBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('Export panorama error:', error);
    return NextResponse.json({
      error: 'Failed to generate asset panorama CSV',
      detail: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}
