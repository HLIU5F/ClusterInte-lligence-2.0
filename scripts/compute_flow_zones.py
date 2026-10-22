#!/usr/bin/env python3
"""
把「通信锚点域（方案2）」的计算搬到 Neo4j，结果持久化为 :FlowZone。

为什么要在库里算
----------------
前端每次刷新都在浏览器里重算一遍，结果不持久、不可共享，也受浏览器算力限制。
锚点提取本身是**全图两跳遍历**（本库 3358 节点 / 23741 边 / 2123 种端口），
放在库里一次查询就能拿到，再把结果写成图谱元素供前端/导出直接读。

写入的图谱元素（**不动数据自带的 6 个安全域** :Zone）
-----------------------------------------------------
  (:FlowZone {id, label, color, ip_count, direction, source, created_at})
  (:IP)-[:IN_FLOW_ZONE]->(:FlowZone)
  ip.flow_zone_id / ip.flow_zone_label / ip.flow_direction / ip.flow_callers / ip.flow_peers

算法（与 src/lib/clustering.ts 的 clusterByFlowAnchor **逐行一致**，因此命名可对齐）
----------------------------------------------------------------------------------
  1. 每条有向边 (src → dst) 的每个「非监控端口」p 构成一个锚点
  2. 服务锚点（dst 侧）：别人以 p 调用我 → 记录调用方 /24
  3. 消费锚点（src 侧）：我以 p 访问别人 → 记录对端 /24
  4. zone_id 生成规则：
       有服务锚点：flow_svc_<服务类别签名>|<自身/24>[|callers:<调用方/24 排序>][|role:<角色>]
       否则有消费锚点：flow_cli_<消费类别签名>|<自身/24>[|peers:<对端/24 排序>][|role:<角色>]
       都没有：flow_cli_none|<自身/24>          （监控终端）
  5. 采集/汇聚节点（MONITOR_IPS 或 邻居数 ≥ max(50, 30% 节点数)）单独归入 flow_collector

用法
----
    python scripts/compute_flow_zones.py --dry-run            # 只算不写
    python scripts/compute_flow_zones.py                      # 写入（默认含标签细化）
    python scripts/compute_flow_zones.py --no-enrich-labels   # 不并入 role 标签
    python scripts/compute_flow_zones.py --keep                # 不清理旧 FlowZone

凭据从项目根目录 .env.local 读取（经 scripts/env.py），脚本内不硬编码密码。
"""

from __future__ import annotations

import argparse
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

from neo4j import GraphDatabase

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from env import get_password, get_uri, get_user, load_env_local  # noqa: E402

# ---- 与前端一致的常量 ----------------------------------------------------

MONITOR_PORTS = {36000, 9100, 9101, 1514, 1515, 6514}

SERVICE_CLASS_LABELS = {
    "web": "Web 服务", "database": "数据库", "cache": "缓存", "messaging": "消息队列",
    "email": "邮件", "remote": "远程管理", "dns": "DNS", "file_transfer": "文件传输",
    "auth": "认证服务", "logging": "日志采集", "monitoring": "监控",
    "system": "系统服务", "other": "其他",
}

ROLE_LABELS = {
    "web_server": "Web 服务", "database": "数据库", "cache": "缓存服务",
    "message_queue": "消息队列", "monitoring": "监控采集", "load_balancer": "负载均衡",
    "api_gateway": "API 网关", "file_server": "文件服务", "dns_server": "DNS 服务",
    "mail_server": "邮件服务", "bastion_host": "跳板机/管理服务器",
    "admin_server": "管理服务器", "ldap_server": "LDAP 服务",
    "rpc_service": "RPC/NFS 服务", "data_platform": "数据平台/日志基础设施",
    "unknown": "未知角色",
}

ZONE_COLORS = [
    "#00d4ff", "#ff6b35", "#a855f7", "#10b981", "#f59e0b", "#ec4899",
    "#22d3ee", "#84cc16", "#f43f5e", "#8b5cf6", "#fb923c", "#06b6d4",
]


def log(msg: str) -> None:
    print(msg, flush=True)


def subnet24(ip: str) -> str:
    parts = str(ip).split(".")
    return ".".join(parts[:3]) if len(parts) == 4 else str(ip)


def classify_port(port: int) -> str:
    """端口 → 服务类别（与 src/lib/clustering.ts classifyPort 保持一致）"""
    if port in (80, 443, 8080, 8443, 8000, 3000, 5000, 8888, 9090):
        return "web"
    if port in (3306, 5432, 1433, 1521, 27017, 6379, 9042, 7000):
        return "database"
    if port in (11211, 6379, 7000, 7001):
        return "cache"
    if port in (5672, 9092, 1883, 61616, 9093, 11211):
        return "messaging"
    if port in (25, 110, 143, 587, 993, 995):
        return "email"
    if port in (22, 23, 3389, 5900, 5901):
        return "remote"
    if port in (53, 853):
        return "dns"
    if port in (21, 20, 69, 115, 2049):
        return "file_transfer"
    if port in (88, 389, 636, 1812, 1813, 8649):
        return "auth"
    if port in (514, 6514, 9200, 9300, 8086, 5044):
        return "logging"
    if port in (161, 162, 9100, 9101, 9090):
        return "monitoring"
    if port < 1024:
        return "system"
    return "other"


def monitor_ips() -> set:
    raw = os.environ.get("MONITOR_IPS") or os.environ.get("NEXT_PUBLIC_MONITOR_IPS") or ""
    ips = {x.strip() for x in raw.split(",") if x.strip()}
    return ips or {"10.255.0.1", "10.255.0.2", "10.255.0.3"}


# ---- 从库里取锚点 --------------------------------------------------------

def fetch_anchors(session):
    """一次全图遍历拿到所有 (src, dst, port) 锚点三元组。"""
    rows = session.run(
        """
        MATCH (s:IP)-[r:CONNECTS_TO]->(d:IP)
        UNWIND coalesce(r.ports, []) AS rawPort
        WITH toInteger(rawPort) AS port, s.id AS s, d.id AS d
        WHERE port IS NOT NULL
        RETURN s, d, port
        """
    ).data()
    degrees = {
        rec["id"]: rec["degree"]
        for rec in session.run(
            """
            MATCH (n:IP)
            OPTIONAL MATCH (n)-[r:CONNECTS_TO]-()
            RETURN n.id AS id, count(r) AS degree
            """
        ).data()
    }
    meta = {
        rec["id"]: {"role_guess": rec["role_guess"], "zone_label": rec["zone_label"]}
        for rec in session.run(
            "MATCH (n:IP) RETURN n.id AS id, n.role_guess AS role_guess, n.zone_label AS zone_label"
        ).data()
    }
    return rows, degrees, meta


def build_zones(rows, degrees, meta, monitor, enrich_labels):
    svc_port_map = defaultdict(set)      # node -> {port}
    con_port_map = defaultdict(set)
    anchor_callers = defaultdict(set)    # "node|port" -> {caller /24}
    anchor_peers = defaultdict(set)

    for row in rows:
        s, d, port = row["s"], row["d"], int(row["port"])
        if port in MONITOR_PORTS:
            continue
        sk = "%s|%d" % (d, port)
        anchor_callers[sk].add(subnet24(s))
        svc_port_map[d].add(port)
        ck = "%s|%d" % (s, port)
        anchor_peers[ck].add(subnet24(d))
        con_port_map[s].add(port)

    total = len(degrees)
    collector_threshold = max(50, -(-total * 3 // 10))  # ceil(total * 0.3)

    zones = defaultdict(list)
    label_of = {}
    direction_of = {}
    extra_of = {}

    for node_id, degree in degrees.items():
        if node_id in monitor or degree >= collector_threshold:
            zones["flow_collector"].append(node_id)
            label_of["flow_collector"] = "采集节点（监控/汇聚）"
            direction_of["flow_collector"] = "collector"
            continue

        svc_ports = svc_port_map.get(node_id, set())
        con_ports = con_port_map.get(node_id, set())
        callers = set()
        for p in svc_ports:
            callers |= anchor_callers.get("%s|%d" % (node_id, p), set())
        peers = set()
        for p in con_ports:
            peers |= anchor_peers.get("%s|%d" % (node_id, p), set())

        svc_classes = sorted({classify_port(p) for p in svc_ports} - {"other"})
        con_classes = sorted({classify_port(p) for p in con_ports} - {"other"})
        svc_sig = "+".join(svc_classes)
        con_sig = "+".join(con_classes)

        subnet = subnet24(node_id)
        role = (meta.get(node_id) or {}).get("role_guess")
        role_tag = ""
        role_label = ""
        if enrich_labels and role and role != "unknown":
            role_tag = "|role:%s" % role
            role_label = " · %s" % ROLE_LABELS.get(role, role)

        if svc_sig:
            caller_key = ",".join(sorted(callers))
            zone_id = "flow_svc_%s|%s%s%s" % (
                svc_sig, subnet, ("|callers:" + caller_key) if caller_key else "", role_tag)
            label = "%s · %s（服务提供）%s%s" % (
                " + ".join(SERVICE_CLASS_LABELS.get(c, c) for c in svc_classes),
                subnet, " · 被 %s 调用" % caller_key if caller_key else "", role_label)
            direction = "service"
            extra = ("callers", caller_key)
        elif con_sig:
            peer_key = ",".join(sorted(peers))
            zone_id = "flow_cli_%s|%s%s%s" % (
                con_sig, subnet, ("|peers:" + peer_key) if peer_key else "", role_tag)
            label = "%s 客户端 · %s%s%s" % (
                " + ".join(SERVICE_CLASS_LABELS.get(c, c) for c in con_classes),
                subnet, " · 访问 %s" % peer_key if peer_key else "", role_label)
            direction = "client"
            extra = ("peers", peer_key)
        else:
            zone_id = "flow_cli_none|%s" % subnet
            label = "监控终端 · %s" % subnet
            direction = "terminal"
            extra = (None, "")

        zones[zone_id].append(node_id)
        label_of[zone_id] = label
        direction_of[zone_id] = direction
        extra_of[zone_id] = extra

    return zones, label_of, direction_of, extra_of


# ---- 写回 ---------------------------------------------------------------

def materialize(session, zones, label_of, direction_of, extra_of, enrich_labels, keep):
    now = datetime.now(timezone.utc).isoformat()
    src = "cypher:flow_anchor%s" % ("+labels" if enrich_labels else "")

    zone_rows = []
    ip_rows = []
    for idx, (zone_id, members) in enumerate(
        sorted(zones.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    ):
        zone_rows.append({
            "id": zone_id,
            "label": label_of.get(zone_id, zone_id),
            "color": ZONE_COLORS[idx % len(ZONE_COLORS)],
            "ip_count": len(members),
            "direction": direction_of.get(zone_id),
        })
        field, value = extra_of.get(zone_id, (None, ""))
        for ip in members:
            ip_rows.append({
                "ip_id": ip,
                "zone_id": zone_id,
                "zone_label": label_of.get(zone_id, zone_id),
                "direction": direction_of.get(zone_id),
                "callers": value if field == "callers" else None,
                "peers": value if field == "peers" else None,
            })

    if not keep:
        session.run("MATCH (:IP)-[r:IN_FLOW_ZONE]->(:FlowZone) DELETE r")
        session.run("MATCH (fz:FlowZone) DETACH DELETE fz")
        session.run(
            """
            MATCH (ip:IP)
            REMOVE ip.flow_zone_id, ip.flow_zone_label, ip.flow_direction,
                   ip.flow_callers, ip.flow_peers
            """
        )
        log("  · 已清理旧 FlowZone / IN_FLOW_ZONE / ip.flow_*")

    session.run(
        "CREATE CONSTRAINT flowzone_id_unique IF NOT EXISTS FOR (n:FlowZone) REQUIRE n.id IS UNIQUE"
    )
    session.run(
        "CREATE INDEX ip_flow_zone IF NOT EXISTS FOR (n:IP) ON (n.flow_zone_id)"
    )

    session.run(
        """
        UNWIND $rows AS r
        MERGE (fz:FlowZone {id: r.id})
        SET fz.label = r.label, fz.color = r.color, fz.ip_count = r.ip_count,
            fz.direction = r.direction, fz.source = $src, fz.created_at = $now
        """,
        rows=zone_rows, src=src, now=now,
    )
    for i in range(0, len(ip_rows), 2000):
        session.run(
            """
            UNWIND $rows AS r
            MATCH (ip:IP {id: r.ip_id}), (fz:FlowZone {id: r.zone_id})
            MERGE (ip)-[:IN_FLOW_ZONE]->(fz)
            SET ip.flow_zone_id = r.zone_id, ip.flow_zone_label = r.zone_label,
                ip.flow_direction = r.direction,
                ip.flow_callers = r.callers, ip.flow_peers = r.peers
            """,
            rows=ip_rows[i:i + 2000],
        )
    return src, len(zone_rows), len(ip_rows)


def main() -> int:
    ap = argparse.ArgumentParser(description="在 Neo4j 里计算通信锚点域（方案2）并持久化")
    ap.add_argument("--dry-run", action="store_true", help="只计算与预览，不写库")
    ap.add_argument("--no-enrich-labels", action="store_true", help="不并入 role 标签（标签细化 OFF）")
    ap.add_argument("--keep", action="store_true", help="不清理旧 FlowZone，增量覆盖")
    ap.add_argument("--uri", default=None)
    ap.add_argument("--user", default=None)
    ap.add_argument("--password", default=None)
    args = ap.parse_args()

    load_env_local()
    enrich = not args.no_enrich_labels
    monitor = monitor_ips()

    uri = args.uri or get_uri()
    user = args.user or get_user()
    password = args.password or get_password()
    log("连接 Neo4j：%s（user=%s）" % (uri, user))

    driver = GraphDatabase.driver(uri, auth=(user, password))
    try:
        with driver.session() as session:
            rows, degrees, meta = fetch_anchors(session)
            log("锚点三元组 %d 条；IP 节点 %d 个；监控/采集白名单 %d 个"
                % (len(rows), len(degrees), len(monitor)))

            zones, label_of, direction_of, extra_of = build_zones(
                rows, degrees, meta, monitor, enrich)

            sizes = sorted((len(v) for v in zones.values()), reverse=True)
            log("算法：通信锚点域（方案2）  标签细化 = %s" % ("ON" if enrich else "OFF"))
            log("结果：%d 个域；最大域 %d 台；单节点域 %d 个；平均规模 %.2f"
                % (len(zones), sizes[0], sum(1 for s in sizes if s == 1),
                   len(degrees) / len(zones)))
            log("方向分布：" + str(dict(Counter(direction_of.values()))))

            log("前 6 个域：")
            for zone_id, members in sorted(zones.items(), key=lambda kv: -len(kv[1]))[:6]:
                log("  · %-4d 台  %s" % (len(members), label_of.get(zone_id)))

            if args.dry_run:
                log("\n--dry-run：未写入任何数据。")
                return 0

            src, nz, ni = materialize(session, zones, label_of, direction_of, extra_of,
                                      enrich, args.keep)
            log("\n写入完成：source=%s  →  FlowZone %d 个 / IP 归宿 %d 条" % (src, nz, ni))
            log("验证：")
            for q, label in [
                ("MATCH (fz:FlowZone) RETURN count(fz) AS c", "FlowZone 数"),
                ("MATCH ()-[r:IN_FLOW_ZONE]->() RETURN count(r) AS c", "IN_FLOW_ZONE"),
                ("MATCH (ip:IP) WHERE ip.flow_zone_id IS NOT NULL RETURN count(ip) AS c", "带 flow_zone_id 的 IP"),
                ("MATCH (z:Zone) RETURN count(z) AS c", "原有 Zone（应仍为 6）"),
            ]:
                rec = session.run(q).single()
                log("  %-24s %s" % (label, rec["c"] if rec else "?"))
            return 0
    finally:
        driver.close()


if __name__ == "__main__":
    sys.exit(main())
