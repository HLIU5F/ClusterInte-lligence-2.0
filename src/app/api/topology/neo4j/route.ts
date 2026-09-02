/**
 * GET /api/topology/neo4j
 *
 * 一次性把整套拓扑数据从 Neo4j 拉回前端：
 *   - metadata（节点数 / 边数 / 社区数 / 时间戳）
 *   - nodes[]   （每个 IP 附 subnet_24、zone_id、zone_color、anomaly 字段）
 *   - links[]   （CONNECTS_TO 关系）
 *   - zones[]   （每个安全域的 id / label / color / ip 数 / subnet 数）
 *
 * 前端拿到的就是「按 Zone 颜色一致」的数据源，渲染层不用再自己算颜色。
 */

import { NextResponse } from 'next/server';
import { runCypher } from '@/lib/neo4j';

interface IpRecord {
  id: string;
  community: number;
  subnet_24: string;
  subnet_cidr?: string;
  zone_id: string | null;
  zone_color: string | null;
  zone_label: string | null;
  degree: number;
  in_degree: number;
  out_degree: number;
  anomaly_score: number;
  is_hub: boolean;
  service_type: string | null;
  geo_country: string | null;
  business_group: string | null;
  os_name: string | null;
  application: string | null;
  owner: string | null;
  environment: string | null;
  cmdb_tags: string[] | null;
  // Neo4j 里 IP 节点存的是列表：ports: number[]（如 [443, 36000]）、protocols: string[]（如 ["tcp"]）
  ports: number[];
  protocols: string[];
}

interface LinkRecord {
  src: string;
  dst: string;
  weight: number;
  bytes: number;
  // CONNECTS_TO 关系属性同样是列表：ports: number[]、protocols: string[]
  ports: number[];
  protocols: string[];
}

// Neo4j HTTP API 返回的 JSON 里数字可能是浮点（6379.0），且个别历史数据可能是标量而非列表；
// 统一归一化为 number[] / string[]，避免前端 signature 匹配出错。
function toNumberList(v: unknown): number[] {
  if (Array.isArray(v)) return v.map(x => Number(x)).filter(n => Number.isFinite(n));
  if (v == null) return [];
  const n = Number(v);
  return Number.isFinite(n) ? [n] : [];
}

function toStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(x => String(x));
  if (v == null) return [];
  return [String(v)];
}

// ============ 流量统计 / 角色 / 异常启发式（服务端派生，DB 只存原始事实） ============
// 导入脚本只写入 ports/protocols/weight/degree；in_degree / out_degree / 角色 / 异常分都是派生值，
// 统一在这里按 CONNECTS_TO 关系计算，保证"从 Neo4j 加载"路径与 Excel 导入路径行为一致。

/** 端口 → 角色（键与前端 ROLE_LABELS 一致：web_server / database / cache / message_queue / monitoring / dns_server / …） */
const PORT_ROLE: Record<number, string> = {
  80: 'web_server', 81: 'web_server', 443: 'web_server', 3000: 'web_server', 5000: 'web_server',
  8000: 'web_server', 8080: 'web_server', 8443: 'web_server', 8888: 'web_server', 9090: 'web_server',
  3306: 'database', 5432: 'database', 1433: 'database', 1521: 'database', 27017: 'database',
  6379: 'cache', 6380: 'cache', 11211: 'cache', 16380: 'cache',
  9092: 'message_queue', 9093: 'message_queue', 9094: 'message_queue',
  5672: 'message_queue', 61616: 'message_queue', 2181: 'message_queue',
  1514: 'monitoring', 1515: 'monitoring', 1516: 'monitoring', 1517: 'monitoring', 514: 'monitoring',
  36000: 'monitoring', 9100: 'monitoring', 9101: 'monitoring',
  6514: 'monitoring', 7070: 'monitoring', 9000: 'monitoring',
  53: 'dns_server',
  25: 'mail_server', 110: 'mail_server', 143: 'mail_server', 587: 'mail_server',
  21: 'file_server', 20: 'file_server', 69: 'file_server', 2049: 'file_server',
  389: 'ldap_server', 636: 'ldap_server',
  111: 'rpc_service',
  9200: 'data_platform', 9201: 'data_platform', 9300: 'data_platform',
  5044: 'data_platform', 9600: 'data_platform', 5601: 'data_platform',
};

/** 数据库端口：非 database/cache 角色暴露 → 风险信号 */
const DB_PORTS = [3306, 5432, 1433, 1521, 27017, 6379, 11211];

/** 高危管理/扫描端口：出现频次高且非本职端口 → 疑似扫描/横向移动 */
const SCAN_PORTS = new Set([22, 23, 135, 139, 445, 3389, 5900, 5901]);

/** 关键资产角色：正常功能（如 DNS 解析量大）不是异常，只打"重要"标签，不参与异常高分 */
const CRITICAL_ROLES = new Set(['dns_server', 'database', 'cache', 'message_queue']);

/**
 * 组合角色判定（优先级从高到低）：
 *  1. 已知采集/汇聚设备 → monitoring
 *  2. 数据平台/日志基础设施：提供 ES(9200/9300)、Logstash(5044/9600)、Kibana(5601)，
 *     或 Kafka(9092) + ES/日志管道端口组合 —— 存储日志/消息数据，安全策略与 Web 服务器不同
 *  3. 22 + 443/80/8080/8443 → bastion_host（跳板/管理：SSH + Web 管理面）
 *  4. ≥2 个管理端口（22/3389/5900/5901/23）→ admin_server（纯管理主机）
 *  5. 其余先查单端口映射，再回退 unknown；单独 22 主导且无 Web 端口 → admin_server。
 */
function deriveRole(portCount: Map<number, number>, nodeId: string): string {
  const has = (p: number) => portCount.has(p);
  if (KNOWN_COLLECTOR_IPS.has(nodeId)) return 'monitoring';
  if (has(9200) || has(9300) || has(5044) || has(9600) || has(5601)
      || (has(9092) && (has(9200) || has(9201) || has(5044) || has(9600) || has(5601)))) return 'data_platform';
  if (has(22) && (has(443) || has(80) || has(8080) || has(8443))) return 'bastion_host';
  const manageHits = [22, 3389, 5900, 5901, 23].filter(p => has(p)).length;
  if (manageHits >= 2) return 'admin_server';
  let domPort = 0, domCnt = 0;
  for (const [p, c] of portCount) { if (c > domCnt) { domCnt = c; domPort = p; } }
  if (domPort === 22 && !has(443) && !has(80) && !has(8080) && !has(8443)) return 'admin_server';
  return domPort ? (PORT_ROLE[domPort] || 'unknown') : 'unknown';
}

/** 监控/采集端口：主导端口落在这些端口的资产视为监控资产，不计入异常（与聚类层 MONITOR_PORTS 一致） */
const MONITOR_DOMINANT_PORTS = new Set([36000, 9100, 9101, 6514, 1514, 1515, 1516, 1517, 7070, 9000]);

/** 已知采集 / 汇聚 / 安全设备（与聚类层 KNOWN_COLLECTOR_IPS 保持一致） */
const KNOWN_COLLECTOR_IPS = new Set(['10.26.0.26', '10.20.3.25', '10.100.113.134']);

/**
 * 风险分（连续、可解释、可校准）——端口 + 图特征双维度，只把"异常行为/暴露风险"计分：
 *
 * 基线 0.15；采集/监控资产 0.05；关键资产（DNS/DB/缓存/MQ）0.10（只保留跨子网信号与行为信号）。
 * 非关键资产按因子累加（上限 0.95）：
 *  - A 暴露面：6 端口起跳 +0.18，每多 1 端口 +0.05，上限 +0.4
 *  - B 数据库端口暴露（非关键资产）：1 类 +0.15，≥2 类 +0.25
 *  - C 邻居子网多样性（跨域通信代理）：≥3 个 +0.08，≥5 个 +0.15
 *  - D 流量极端（正常功能，弱信号）：w≥3000 +0.06 / ≥6000 +0.10 / ≥8000 +0.15
 *  - E 权重集中度：单条边占比 ≥85% 且 ≥3 条边（单目标流量主导/数据泵）→ +0.10；
 *    最大边占比 ≤50% 且 ≥4 条边（多目标均衡/横向扩散特征）→ +0.12
 *  - F 低权重连接占比：weight≤2 的边 ≥2/3 且 ≥3 条边（大量低频连接/探测巡检）→ +0.10
 *  - G 节点度（连接数）：≥8 +0.08，≥15 +0.15（多目标通信规模；主机间流量接入后更有区分度）
 *  - H 跨子网边占比：度 ≥8 且 ≥80% 边跨 /24 子网（广泛跨域通信/横向扩散）→ +0.12
 *    （Zone 数据建立后，C/H 自动升级为真实跨安全域信号）
 * 行为强信号优先（关键资产也不豁免）：
 *  - 扫描/横向移动：高危端口出现在 ≥3 条连接上且非本职端口 → 0.85 Critical
 *  - 角色-端口冲突：≥3 个高危管理端口 → 0.60 High
 * 等级：≥0.75 Critical / ≥0.60 High / ≥0.45 Medium / 其余 Low（内部连续分层）。
 */
function isCollectorLike(degree: number, totalNodes: number): boolean {
  return degree >= Math.max(50, Math.ceil(totalNodes * 0.3));
}

interface ZoneRecord {
  id: string;
  label: string;
  color: string;
  ips: number;
  subnets: number;
}

export async function GET(request: Request) {
  try {
    // 默认只返回"有连接关系"的节点（≈ 核心图规模），避免前端一次性渲染数千个孤立节点卡死。
    // 需要全量清单时用 ?all=1。
    const url = new URL(request.url);
    const includeAll = url.searchParams.get('all') === '1';
    const connectedFilter = includeAll ? '' : 'WHERE exists((ip)-[:CONNECTS_TO]-())';

    // 1) 节点 + 它们的 Subnet + Zone（一次 JOIN 取齐）
    // Run the three topology queries in parallel instead of serially.
    const [ipRecords, linkRecords, zoneRecords] = await Promise.all([
      runCypher<IpRecord>(`
        MATCH (ip:IP)
        ${connectedFilter}
        OPTIONAL MATCH (ip)-[:BELONGS_TO]->(sn:Subnet)
        OPTIONAL MATCH (sn)-[:IN_ZONE]->(z:Zone)
        OPTIONAL MATCH (ip)-[:BELONGS_TO_GROUP]->(bg:BusinessGroup)
        OPTIONAL MATCH (ip)-[:RUNS_ON]->(os:OS)
        OPTIONAL MATCH (ip)-[:RUNS_APP]->(app:Application)
        OPTIONAL MATCH (ip)-[:IN_ENVIRONMENT]->(env:Environment)
        RETURN
          ip.id           AS id,
          ip.community    AS community,
          ip.subnet_24    AS subnet_24,
          sn.cidr         AS subnet_cidr,
          z.id            AS zone_id,
          z.color         AS zone_color,
          z.label         AS zone_label,
          coalesce(ip.degree, 0)        AS degree,
          coalesce(ip.in_degree, 0)     AS in_degree,
          coalesce(ip.out_degree, 0)    AS out_degree,
          coalesce(ip.anomaly_score, 0) AS anomaly_score,
          coalesce(ip.is_hub, false)    AS is_hub,
          ip.service_type               AS service_type,
          ip.geo_country                AS geo_country,
          head(collect(DISTINCT bg.name)) AS business_group,
          head(collect(DISTINCT os.name)) AS os_name,
          head(collect(DISTINCT app.name)) AS application,
          ip.owner                      AS owner,
          head(collect(DISTINCT env.name)) AS environment,
          coalesce(ip.cmdb_tags, [])    AS cmdb_tags,
          coalesce(ip.ports, [])        AS ports,
          coalesce(ip.protocols, [])    AS protocols
      `),
      runCypher<LinkRecord>(`
        MATCH (a:IP)-[r:CONNECTS_TO]->(b:IP)
        RETURN a.id AS src, b.id AS dst,
               coalesce(r.weight, 1) AS weight,
               coalesce(r.bytes, 0)  AS bytes,
               coalesce(r.ports, []) AS ports,
               coalesce(r.protocols, []) AS protocols
      `),
      runCypher<ZoneRecord>(`
        MATCH (z:Zone)
        OPTIONAL MATCH (sn:Subnet)-[:IN_ZONE]->(z)
        OPTIONAL MATCH (ip:IP)-[:BELONGS_TO]->(sn)
        WITH z, count(DISTINCT sn) AS subnets, count(DISTINCT ip) AS ips
        RETURN z.id AS id, z.label AS label, z.color AS color,
               ips, subnets
        ORDER BY z.id
      `),
    ]);

    // ---- 按 CONNECTS_TO 重算每节点流量统计（DB 未存 in_degree/out_degree/总流量，避免全 0）----
    const inDeg = new Map<string, number>();
    const outDeg = new Map<string, number>();
    const totalWeight = new Map<string, number>(); // Σ weight = 连接总次数（频率）
    const linkPorts = new Map<string, Set<number>>();
    const subnetOf = new Map<string, string>();
    for (const r of ipRecords) subnetOf.set(r.id, r.subnet_24 ?? r.subnet_cidr ?? '0.0.0.0/0');
    const nbrSubnets = new Map<string, Set<string>>(); // 邻居 /24 子网多样性（跨域通信代理）
    const edgeWeights = new Map<string, number[]>();   // 节点每条关联边的 weight（权重分布）
    const crossSubnetEdges = new Map<string, number>(); // 跨 /24 子网的边数
    for (const l of linkRecords) {
      const w = Number(l.weight) || 1;
      outDeg.set(l.src, (outDeg.get(l.src) || 0) + 1);
      inDeg.set(l.dst, (inDeg.get(l.dst) || 0) + 1);
      totalWeight.set(l.src, (totalWeight.get(l.src) || 0) + w);
      totalWeight.set(l.dst, (totalWeight.get(l.dst) || 0) + w);
      for (const id of [l.src, l.dst]) {
        if (!edgeWeights.has(id)) edgeWeights.set(id, []);
        edgeWeights.get(id)!.push(w);
      }
      const ps = toNumberList(l.ports);
      if (ps.length > 0) {
        for (const id of [l.src, l.dst]) {
          let set = linkPorts.get(id);
          if (!set) { set = new Set(); linkPorts.set(id, set); }
          for (const p of ps) set.add(p);
        }
      }
      const ss = subnetOf.get(l.src) ?? '';
      const ts = subnetOf.get(l.dst) ?? '';
      if (ss) {
        if (!nbrSubnets.has(l.dst)) nbrSubnets.set(l.dst, new Set());
        nbrSubnets.get(l.dst)!.add(ss);
      }
      if (ts) {
        if (!nbrSubnets.has(l.src)) nbrSubnets.set(l.src, new Set());
        nbrSubnets.get(l.src)!.add(ts);
      }
      if (ss && ts && ss !== ts) {
        crossSubnetEdges.set(l.src, (crossSubnetEdges.get(l.src) || 0) + 1);
        crossSubnetEdges.set(l.dst, (crossSubnetEdges.get(l.dst) || 0) + 1);
      }
    }

    // 采集节点集合（已知采集 IP 或邻居数超阈值，与聚类层一致）
    const collectorIds = new Set<string>();
    for (const r of ipRecords) {
      const deg = (inDeg.get(r.id) || 0) + (outDeg.get(r.id) || 0);
      if (KNOWN_COLLECTOR_IPS.has(r.id) || isCollectorLike(deg, ipRecords.length)) collectorIds.add(r.id);
    }

    // 每个节点的派生统计：角色（组合端口规则）+ 风险分（连续因子）+ 入出度
    const nodeStats = new Map<string, {
      inD: number; outD: number; deg: number; totalW: number;
      role: string; anomaly: number; isHub: boolean; isCritical: boolean;
    }>();
    for (const r of ipRecords) {
      const inD = inDeg.get(r.id) || 0;
      const outD = outDeg.get(r.id) || 0;
      const deg = inD + outD;
      const totalW = totalWeight.get(r.id) || 0;
      const nbrSubnetCount = nbrSubnets.get(r.id)?.size || 0;
      // 端口频次：节点自身端口 + 关联边端口（= 该端口出现在几条连接上）
      const portCount = new Map<number, number>();
      for (const p of toNumberList(r.ports)) portCount.set(p, (portCount.get(p) || 0) + 1);
      for (const p of linkPorts.get(r.id) || []) portCount.set(p, (portCount.get(p) || 0) + 1);
      let domPort = 0, domCnt = 0;
      for (const [p, c] of portCount) { if (c > domCnt) { domCnt = c; domPort = p; } }
      const role = deriveRole(portCount, r.id);
      const isCritical = CRITICAL_ROLES.has(role);

      let aScore = 0.15;
      if (!collectorIds.has(r.id)) {
        if (domPort && MONITOR_DOMINANT_PORTS.has(domPort)) {
          aScore = 0.05; // 监控资产不标异常
        } else {
          // 行为强信号优先（关键资产也不豁免）：
          // 1) 扫描/横向移动：高危端口出现在 ≥3 条连接上，且不是本职端口
          let scanMax = 0;
          for (const [p, c] of portCount) {
            if (SCAN_PORTS.has(p) && p !== domPort && c > scanMax) scanMax = c;
          }
          if (scanMax >= 3) {
            aScore = 0.85;
          } else {
            // 2) 角色-端口冲突：有明确角色但端口集合含 ≥3 个高危管理端口
            if (role !== 'unknown') {
              const manageHits = [22, 3389, 5900, 5901, 23].filter(p => portCount.has(p)).length;
              if (manageHits >= 3) aScore = Math.max(aScore, 0.6);
            }
            if (isCritical) {
              // 关键资产（DNS/DB/缓存/MQ）：正常功能不加分，仅保留跨子网信号；行为信号不豁免
              aScore = Math.max(aScore, 0.1);
              if (nbrSubnetCount >= 3) aScore = Math.max(aScore, 0.18);
            } else {
              // A. 暴露面：6 端口起跳 +0.18，每多 1 端口 +0.05，上限 +0.4
              aScore += Math.min(0.4, Math.max(0, portCount.size - 5) * 0.05 + (portCount.size >= 6 ? 0.18 : 0));
              // B. 数据库端口暴露（非关键资产）：1 类 +0.15，≥2 类 +0.25
              const dbHits = DB_PORTS.filter(p => portCount.has(p)).length;
              if (dbHits >= 2) aScore += 0.25;
              else if (dbHits === 1) aScore += 0.15;
              // C. 邻居子网多样性（Zone 接入前用 /24 子网代理）
              if (nbrSubnetCount >= 5) aScore += 0.15;
              else if (nbrSubnetCount >= 3) aScore += 0.08;
              // D. 流量极端（正常功能，弱信号）
              if (totalW >= 8000) aScore += 0.15;
              else if (totalW >= 6000) aScore += 0.1;
              else if (totalW >= 3000) aScore += 0.06;
              // ---- 图特征（利用 CONNECTS_TO 关系，不只是端口分类） ----
              const ws = edgeWeights.get(r.id) || [];
              const nEdges = ws.length;
              if (nEdges > 0) {
                let maxW = 0, sum = 0, lowCnt = 0;
                for (const x of ws) { sum += x; if (x > maxW) maxW = x; if (x <= 2) lowCnt++; }
                const maxShare = sum > 0 ? maxW / sum : 0;
                // E. 权重分布形态（互斥，避免"1 条大边+几条小边"重复计分）：
                //    - 单目标流量主导（数据泵/单向同步）：1 条边占 ≥90% 且 ≥3 条边
                //    - 多目标均衡（横向扩散特征）：最大边占比 ≤50% 且 ≥4 条边
                //    - 多条低频连接（探测/巡检特征）：≥4 条边且 ≥3 条 weight≤2
                if (maxShare >= 0.9 && nEdges >= 3) aScore += 0.1;
                else if (maxShare <= 0.5 && nEdges >= 4) aScore += 0.12;
                else if (lowCnt >= 3 && nEdges >= 4) aScore += 0.08;
                // H. 跨子网边占比：广泛跨域通信（横向扩散特征，需高连接数才触发）
                const crossShare = (crossSubnetEdges.get(r.id) || 0) / nEdges;
                if (deg >= 8 && crossShare >= 0.8) aScore += 0.12;
              }
              // G. 节点度（连接数）：多目标通信规模（主机间流量接入后更有区分度）
              if (deg >= 15) aScore += 0.15;
              else if (deg >= 8) aScore += 0.08;
            }
          }
        }
      } else {
        aScore = 0.05; // 采集/汇聚 hub 不标异常
      }
      aScore = Math.min(aScore, 0.95);
      nodeStats.set(r.id, {
        inD, outD, deg, totalW, role,
        anomaly: aScore,
        isHub: collectorIds.has(r.id) || deg >= 50,
        isCritical,
      });
    }

    // 用 ipRecords 构建节点数组（zone_color / zone_id 都是 Neo4j 直接给的，没有就 fallback 到 -1 域）
    const nodes = ipRecords.map(r => {
      const st = nodeStats.get(r.id)!;
      const anomalyScore = Math.round(st.anomaly * 1000) / 1000;
      return {
        id: r.id,
        community: r.community,
        subnet_24: r.subnet_24 ?? r.subnet_cidr ?? '0.0.0.0/0',
        zone_id: r.zone_id ?? '-1',
        zone_color: r.zone_color ?? '#64748b',
        zone_label: r.zone_label ?? 'Unassigned',
        degree: st.deg || Number(r.degree) || 0,
        in_degree: st.inD,
        out_degree: st.outD,
        anomaly_score: anomalyScore,
        is_anomaly: anomalyScore >= 0.6,
        anomaly_level:
          anomalyScore >= 0.75 ? 'Critical' :
          anomalyScore >= 0.60 ? 'High' :
          anomalyScore >= 0.45 ? 'Medium' : 'Low',
        is_hub: st.isHub,
        is_critical: st.isCritical,
        service_type: r.service_type,
        geo_country: r.geo_country,
        business_group: r.business_group ?? null,
        os_name: r.os_name ?? null,
        application: r.application ?? null,
        owner: r.owner ?? null,
        environment: r.environment ?? null,
        cmdb_tags: Array.isArray(r.cmdb_tags) ? r.cmdb_tags : [],
        ports: toNumberList(r.ports),
        protocols: toStringList(r.protocols),
        // 角色：主导端口 → 服务角色（不再回退成 service_type/unknown）
        role_guess: st.role,
      };
    });

    // 给每条边附上 "是否跨 zone"（前端直接用，不用再算）
    const ipZone = new Map(nodes.map(n => [n.id, n.zone_id]));
    const links = linkRecords.map(l => ({
      source: l.src,
      target: l.dst,
      weight: Number(l.weight) || 1,
      bytes: Number(l.bytes) || 0,
      ports: toNumberList(l.ports),
      protocols: toStringList(l.protocols),
      is_cross_domain: (ipZone.get(l.src) ?? '') !== (ipZone.get(l.dst) ?? ''),
    }));

    return NextResponse.json({
      metadata: {
        generated_at: new Date().toISOString(),
        source: 'neo4j',
        total_nodes: nodes.length,
        total_links: links.length,
        communities: new Set(nodes.map(n => n.community)).size,
      },
      nodes,
      links,
      zones: zoneRecords,
    });
  } catch (err) {
    console.error('[api/topology/neo4j] error:', err);
    return NextResponse.json(
      {
        error: 'Failed to load from Neo4j',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
