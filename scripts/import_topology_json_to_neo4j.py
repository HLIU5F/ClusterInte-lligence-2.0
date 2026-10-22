#!/usr/bin/env python3
"""
把「前端拓扑 JSON」导入 Neo4j —— 面向 topology_for_frontend*.json 这一族数据。

为什么单独写一个而不是直接用 scripts/import_to_neo4j.py
--------------------------------------------------------
那个脚本是给「Enricher 管道产出的实体」用的，直接吃 JSON 时有两个硬伤：

  1. 它按 `n.get('type','IP') == 'IP'` 过滤节点，而 topology_for_frontend_new2.0.json
     的节点是 `type: "Host"` → 过滤后 0 个节点，导入结果为空。
  2. 它不认识 `asset_value` / `security_domain`，这两个高价值字段会被静默丢掉。

本脚本直接读 JSON，自包含、无管道依赖，并额外实体化：

  • (:IP)                       所有节点字段（含 asset_value / security_domain）
  • (:IP)-[:CONNECTS_TO]->(:IP)  weight / bytes / ports / protocols
  • (:Subnet {cidr})             subnet_24 归一化成 x.y.z.0/24
  • (:Zone {id,label,color,ip_count,source})  ← 数据自带的 zone_id / zone_label（真实安全域）
  • (:IP)-[:IN_ZONE]->(:Zone) 与 (:Subnet)-[:IN_ZONE]->(:Zone)（子网多数票）
  • (:GDSZone {algorithm,community,...}) ← 数据自带的 community（预计算社区）
  • (:IP)-[:IN_GDS_ZONE]->(:GDSZone) + ip.gds_louvain

这样 `/api/topology/neo4j` 能直接读到真实安全域（不再全是 'Unassigned'），
`/api/topology/gds` 与前端 GDS 面板也能读到预计算社区。

用法
----
    python scripts/import_topology_json_to_neo4j.py --input public/topology_for_frontend_new2.0.json --dry-run
    python scripts/import_topology_json_to_neo4j.py --input public/topology_for_frontend_new2.0.json --clear
    python scripts/import_topology_json_to_neo4j.py --input <file> --batch-size 5000

凭据从项目根目录 .env.local 读取（经 scripts/env.py），脚本内不硬编码任何密码。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

from neo4j import GraphDatabase

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from env import get_password, get_uri, get_user  # noqa: E402

# 与 scripts/import_to_neo4j.py 保持一致的 12 色
ZONE_COLORS = [
    "#00d4ff", "#ff6b35", "#a855f7", "#10b981", "#f59e0b", "#ec4899",
    "#22d3ee", "#84cc16", "#f43f5e", "#8b5cf6", "#fb923c", "#06b6d4",
]

# 数据里代表「这是一台主机」的 type 取值（兼容 IP / Host 两种写法）
IP_TYPES = {"IP", "Host", "host", "ip"}


def log(msg: str) -> None:
    print(msg, flush=True)


def to_cidr24(subnet_value, ip_value) -> str:
    """`10.10.0` / `10.10.0.12` → `10.10.0.0/24`，与既有库内格式一致。"""
    raw = str(subnet_value or "").strip()
    if raw.endswith("/24"):
        return raw
    parts = (raw or str(ip_value)).split(".")
    if len(parts) >= 3:
        return f"{parts[0]}.{parts[1]}.{parts[2]}.0/24"
    return "0.0.0.0/0"


def endpoint(value):
    """links 的 source/target 允许是字符串或 {id: ...} 对象。"""
    if isinstance(value, dict):
        return value.get("id")
    return value


def load_json(path: str):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def inspect(data, path):
    nodes = data.get("nodes") or []
    links = data.get("links") or []
    meta = data.get("metadata") or {}

    log(f"文件：{path}（{os.path.getsize(path) / 1024 / 1024:.2f} MB）")
    log(f"metadata.source = {meta.get('source')}")
    log(f"节点 {len(nodes)} / 边 {len(links)}")

    type_dist = Counter(str(n.get("type", "(none)")) for n in nodes)
    log(f"节点 type 分布：{dict(type_dist)}")

    ip_nodes = [n for n in nodes if str(n.get("type", "IP")) in IP_TYPES]
    _ip_ids = {id(n) for n in ip_nodes}
    other_nodes = [n for n in nodes if id(n) not in _ip_ids]
    if other_nodes:
        log(f"⚠ 非主机节点 {len(other_nodes)} 个，将被跳过（仅导入 IP/Host）")

    zone_dist = Counter(str(n.get("zone_id", "(none)")) for n in ip_nodes)
    log(f"zone_id 分布（{len(zone_dist)} 种）：")
    for zid, cnt in zone_dist.most_common():
        sample = next((n.get("zone_label") for n in ip_nodes if str(n.get("zone_id")) == zid), "")
        log(f"    {zid:<22} {cnt:>6} 台   label={sample}")

    comm = Counter(n.get("community", -1) for n in ip_nodes)
    log(f"community 数 = {len(comm)}（最大社区 {max(comm.values()) if comm else 0} 台）")

    idset = {n.get("id") for n in ip_nodes}
    # 每条边都要把 ports / protocols / bytes 带上 —— 方案二（通信锚点域）与端口服务域
    # 完全依赖边上的端口签名；丢了它，锚点域会退化成「一个子网一个域」。
    pair_map = {}
    dangling = self_loops = 0
    for l in links:
        s, t = endpoint(l.get("source")), endpoint(l.get("target"))
        if s not in idset or t not in idset:
            dangling += 1
            continue
        if s == t:
            self_loops += 1
            continue
        rec = pair_map.get((s, t))
        if rec is None:
            rec = {"count": 0, "ports": set(), "protocols": set(), "bytes": 0}
            pair_map[(s, t)] = rec
        rec["count"] += 1
        for raw_port in (l.get("ports") or []):
            try:
                rec["ports"].add(int(float(raw_port)))
            except (TypeError, ValueError):
                pass
        for proto in (l.get("protocols") or []):
            rec["protocols"].add(str(proto))
        try:
            rec["bytes"] += int(l.get("bytes") or 0)
        except (TypeError, ValueError):
            pass
    dup_pairs = sum(1 for v in pair_map.values() if v["count"] > 1)
    with_ports = sum(1 for v in pair_map.values() if v["ports"])
    log(f"边的 (src,dst) 重复对数 = {dup_pairs}；悬空边 = {dangling}；自环 = {self_loops}")
    log(f"去重后的唯一边数 = {len(pair_map)}；其中带端口的 = {with_ports}")

    # 字段覆盖
    nfields = Counter()
    for n in ip_nodes:
        for k in n:
            nfields[k] += 1
    for key in ("asset_value", "security_domain", "zone_id", "zone_label", "subnet_24", "role_guess"):
        cov = nfields.get(key, 0)
        log(f"    字段 {key:<18} 覆盖 {cov}/{len(ip_nodes)}")

    return ip_nodes, links, pair_map, dup_pairs


def build_rows(ip_nodes, pair_map):
    now = datetime.now(timezone.utc).isoformat()
    src = "import_topology_json"

    ip_rows = []
    subnet_votes = defaultdict(list)
    for n in ip_nodes:
        ip = n.get("id")
        cidr = to_cidr24(n.get("subnet_24"), ip)
        zone_id = str(n.get("zone_id") or "unassigned")
        zone_label = n.get("zone_label") or zone_id
        ip_rows.append({
            "id": ip,
            "ip": n.get("ip") or ip,
            "name": n.get("name") or ip,
            "subnet_24": cidr,
            "community": int(n.get("community", -1) or -1),
            "degree": int(n.get("degree", 0) or 0),
            "in_degree": int(n.get("in_degree", 0) or 0),
            "out_degree": int(n.get("out_degree", 0) or 0),
            "bytes_sent": int(n.get("bytes_sent", 0) or 0),
            "bytes_received": int(n.get("bytes_received", 0) or 0),
            "is_anomaly": bool(n.get("is_anomaly", False)),
            "anomaly_score": float(n.get("anomaly_score", 0.0) or 0.0),
            "anomaly_level": n.get("anomaly_level"),
            "role_guess": n.get("role_guess"),
            "zone_id": zone_id,
            "zone_label": zone_label,
            "security_domain": n.get("security_domain"),
            "asset_value": float(n.get("asset_value", 0.0) or 0.0),
            "node_type": n.get("type"),
        })
        subnet_votes[cidr].append(zone_id)

    link_rows = [
        {
            "src": s,
            "dst": t,
            "occurrences": rec["count"],
            "ports": sorted(rec["ports"]),
            "protocols": sorted(rec["protocols"]),
            "bytes": rec["bytes"],
        }
        for (s, t), rec in pair_map.items()
    ]

    # Zone 记录：按 zone_id 汇总，颜色按出现顺序固定
    zone_members = Counter(r["zone_id"] for r in ip_rows)
    zone_labels = {}
    for r in ip_rows:
        zone_labels.setdefault(r["zone_id"], r["zone_label"])
    zone_rows = []
    for idx, zid in enumerate(sorted(zone_members, key=lambda z: (-zone_members[z], z))):
        zone_rows.append({
            "id": zid,
            "label": zone_labels.get(zid) or zid,
            "color": ZONE_COLORS[idx % len(ZONE_COLORS)],
            "ip_count": zone_members[zid],
        })

    subnet_rows = [
        {"cidr": cidr, "zone_id": Counter(votes).most_common(1)[0][0]}
        for cidr, votes in subnet_votes.items()
    ]

    # GDSZone 记录：数据自带的 community
    comm_members = Counter(r["community"] for r in ip_rows if r["community"] >= 0)
    comm_zone = {}
    for r in ip_rows:
        if r["community"] >= 0:
            comm_zone.setdefault(r["community"], r["zone_label"])
    gds_rows = []
    for idx, cid in enumerate(sorted(comm_members, key=lambda c: (-comm_members[c], c))):
        gds_rows.append({
            "community": cid,
            "label": comm_zone.get(cid) or f"社区 {cid}",
            "color": ZONE_COLORS[idx % len(ZONE_COLORS)],
            "ip_count": comm_members[cid],
        })

    return ip_rows, link_rows, zone_rows, subnet_rows, gds_rows, now, src


def chunked(seq, size):
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


def import_all(session, ip_rows, link_rows, zone_rows, subnet_rows, gds_rows,
               now, src, clear, batch_size):
    session.run(
        "CREATE CONSTRAINT ip_id_unique IF NOT EXISTS FOR (n:IP) REQUIRE n.id IS UNIQUE"
    )
    session.run(
        "CREATE CONSTRAINT subnet_cidr_unique IF NOT EXISTS FOR (n:Subnet) REQUIRE n.cidr IS UNIQUE"
    )
    session.run(
        "CREATE CONSTRAINT zone_id_unique IF NOT EXISTS FOR (n:Zone) REQUIRE n.id IS UNIQUE"
    )
    session.run("CREATE INDEX ip_subnet IF NOT EXISTS FOR (n:IP) ON (n.subnet_24)")
    session.run("CREATE INDEX ip_community IF NOT EXISTS FOR (n:IP) ON (n.community)")
    session.run("CREATE INDEX ip_domain IF NOT EXISTS FOR (n:IP) ON (n.security_domain)")

    if clear:
        log("  · 清空库（MATCH (n) DETACH DELETE n）…")
        session.run("MATCH (n) DETACH DELETE n")

    log("  · 写入 IP 节点 + Subnet …")
    for batch in chunked(ip_rows, batch_size):
        session.run(
            """
            UNWIND $rows AS r
            MERGE (ip:IP {id: r.id})
            SET ip.ip = r.ip, ip.name = r.name, ip.subnet_24 = r.subnet_24,
                ip.community = r.community, ip.degree = r.degree,
                ip.in_degree = r.in_degree, ip.out_degree = r.out_degree,
                ip.bytes_sent = r.bytes_sent, ip.bytes_received = r.bytes_received,
                ip.is_anomaly = r.is_anomaly, ip.anomaly_score = r.anomaly_score,
                ip.anomaly_level = r.anomaly_level, ip.role_guess = r.role_guess,
                ip.zone_id = r.zone_id, ip.zone_label = r.zone_label,
                ip.security_domain = r.security_domain, ip.asset_value = r.asset_value,
                ip.node_type = r.node_type, ip.imported_at = $now, ip.import_source = $src
            MERGE (sn:Subnet {cidr: r.subnet_24})
            SET sn.updated_at = $now
            MERGE (ip)-[:BELONGS_TO]->(sn)
            """,
            rows=batch, now=now, src=src,
        )

    log("  · 写入 CONNECTS_TO 关系 …")
    for batch in chunked(link_rows, batch_size):
        session.run(
            """
            UNWIND $rows AS r
            MATCH (a:IP {id: r.src}), (b:IP {id: r.dst})
            MERGE (a)-[rel:CONNECTS_TO]->(b)
            SET rel.occurrences = r.occurrences,
                rel.weight = coalesce(rel.weight, r.occurrences),
                rel.ports = r.ports,
                rel.protocols = r.protocols,
                rel.bytes = r.bytes,
                rel.updated_at = $now
            """,
            rows=batch, now=now,
        )

    log("  · 写入 Zone（数据自带安全域）…")
    session.run(
        """
        UNWIND $rows AS r
        MERGE (z:Zone {id: r.id})
        SET z.label = r.label, z.color = r.color, z.ip_count = r.ip_count,
            z.source = $src, z.updated_at = $now
        """,
        rows=zone_rows, src=src, now=now,
    )
    session.run(
        """
        UNWIND $rows AS r
        MATCH (ip:IP {id: r.id}), (z:Zone {id: r.zone_id})
        MERGE (ip)-[:IN_ZONE]->(z)
        """,
        rows=[{"id": r["id"], "zone_id": r["zone_id"]} for r in ip_rows],
    )
    session.run(
        """
        UNWIND $rows AS r
        MATCH (sn:Subnet {cidr: r.cidr}), (z:Zone {id: r.zone_id})
        MERGE (sn)-[:IN_ZONE]->(z)
        """,
        rows=subnet_rows,
    )

    log("  · 写入 GDSZone（数据自带 community）…")
    session.run(
        """
        UNWIND $rows AS r
        MERGE (gz:GDSZone {algorithm: 'community_precomputed', community: r.community})
        SET gz.label = r.label, gz.color = r.color, gz.ip_count = r.ip_count,
            gz.source = $src, gz.created_at = $now
        """,
        rows=gds_rows, src=src, now=now,
    )
    session.run(
        """
        UNWIND $rows AS r
        MATCH (ip:IP {id: r.id}),
              (gz:GDSZone {algorithm: 'community_precomputed', community: r.community})
        MERGE (ip)-[:IN_GDS_ZONE]->(gz)
        SET ip.gds_louvain = r.community
        """,
        rows=[{"id": r["id"], "community": r["community"]}
              for r in ip_rows if r["community"] >= 0],
    )


def verify(session):
    log("\n=== 库内校验 ===")
    checks = [
        ("IP 节点", "MATCH (n:IP) RETURN count(n) AS c"),
        ("Subnet", "MATCH (n:Subnet) RETURN count(n) AS c"),
        ("Zone", "MATCH (n:Zone) RETURN count(n) AS c"),
        ("GDSZone", "MATCH (n:GDSZone) RETURN count(n) AS c"),
        ("CONNECTS_TO", "MATCH ()-[r:CONNECTS_TO]->() RETURN count(r) AS c"),
        ("带端口的 CONNECTS_TO", "MATCH ()-[r:CONNECTS_TO]->() WHERE r.ports IS NOT NULL AND size(r.ports) > 0 RETURN count(r) AS c"),
        ("BELONGS_TO", "MATCH ()-[r:BELONGS_TO]->() RETURN count(r) AS c"),
        ("IN_ZONE", "MATCH ()-[r:IN_ZONE]->() RETURN count(r) AS c"),
        ("IN_GDS_ZONE", "MATCH ()-[r:IN_GDS_ZONE]->() RETURN count(r) AS c"),
        ("有 security_domain 的 IP", "MATCH (n:IP) WHERE n.security_domain IS NOT NULL RETURN count(n) AS c"),
        ("有 asset_value>0 的 IP", "MATCH (n:IP) WHERE n.asset_value > 0 RETURN count(n) AS c"),
    ]
    for label, q in checks:
        rec = session.run(q).single()
        log(f"  {label:<24} {rec['c'] if rec else '?'}")

    log("\n  安全域分布：")
    for rec in session.run(
        """
        MATCH (ip:IP)-[:IN_ZONE]->(z:Zone)
        RETURN z.id AS zone, z.label AS label, count(ip) AS ips
        ORDER BY ips DESC
        """
    ):
        log(f"    {rec['zone']:<16} {rec['ips']:>6} 台   {rec['label']}")

    log("\n  Top-5 资产价值：")
    for rec in session.run(
        """
        MATCH (ip:IP) WHERE ip.asset_value > 0
        RETURN ip.id AS id, ip.asset_value AS v, ip.security_domain AS d, ip.degree AS deg
        ORDER BY v DESC LIMIT 5
        """
    ):
        log(f"    {rec['id']:<18} value={rec['v']:<6} domain={rec['d']:<12} degree={rec['deg']}")


def main() -> int:
    ap = argparse.ArgumentParser(description="把前端拓扑 JSON 导入 Neo4j")
    ap.add_argument("--input", required=True, help="拓扑 JSON 路径")
    ap.add_argument("--dry-run", action="store_true", help="只检查与预览，不写库")
    ap.add_argument("--clear", action="store_true", help="导入前清空整个库（重灌）")
    ap.add_argument("--batch-size", type=int, default=5000)
    ap.add_argument("--uri", default=None)
    ap.add_argument("--user", default=None)
    ap.add_argument("--password", default=None)
    args = ap.parse_args()

    if not os.path.exists(args.input):
        log(f"找不到输入文件：{args.input}")
        return 1

    data = load_json(args.input)
    ip_nodes, links, pair_map, dup_pairs = inspect(data, args.input)

    if not ip_nodes:
        log("没有可导入的主机节点（检查 type 字段），中止。")
        return 1

    ip_rows, link_rows, zone_rows, subnet_rows, gds_rows, now, src = build_rows(
        ip_nodes, pair_map
    )
    log(f"\n计划写入：IP {len(ip_rows)} / 边 {len(link_rows)} / "
        f"Zone {len(zone_rows)} / Subnet {len(subnet_rows)} / GDSZone {len(gds_rows)}")

    if args.dry_run:
        log("\n--dry-run：未写入任何数据。")
        return 0

    uri = args.uri or get_uri()
    user = args.user or get_user()
    password = args.password or get_password()
    log(f"\n连接 Neo4j：{uri}（user={user}）")

    driver = GraphDatabase.driver(uri, auth=(user, password))
    try:
        with driver.session() as session:
            import_all(session, ip_rows, link_rows, zone_rows, subnet_rows, gds_rows,
                       now, src, args.clear, args.batch_size)
            verify(session)
    finally:
        driver.close()

    log("\n完成。验证前端：curl -s localhost:5000/api/health?deep=1 然后点「从 Neo4j 加载数据」")
    return 0


if __name__ == "__main__":
    sys.exit(main())
