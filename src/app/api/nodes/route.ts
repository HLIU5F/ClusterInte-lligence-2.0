// src/app/api/nodes/route.ts
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const nodeId = request.nextUrl.searchParams.get("nodeId") || "";
  const depth = request.nextUrl.searchParams.get("depth") || "1";
  
  // TODO: 连接 Neo4j 查询
  // 暂时返回模拟数据
  
  return NextResponse.json({
    center_node: nodeId,
    depth: parseInt(depth),
    neighbors: [],
    total: 0
  });
}
