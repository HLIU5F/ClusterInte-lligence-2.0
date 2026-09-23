#!/usr/bin/env python3
"""
把安全域（Zone）与 GDS 分区结果**实体化写回 Neo4j**。

背景
----
`GET /api/topology/neo4j` 读取的是 `(:Zone)` 与 `(:IP)-[:IN_ZONE]->(:Zone)`，
但真实库里常常只有：

    (:IP)-[:CONNECTS_TO]->(:IP)
    (:IP)-[:BELONGS_TO]->(:Subnet)

于是 `z.id / z.label / z.color` 全部落空，所有节点的 zone_label 退化成 'Unassigned'，
安全域只能靠前端 `computeClustering('security_v3')` 现算（换台机器/刷新就重算一遍）。

本脚本离线用 networkx 在 CONNECTS_TO 图上跑社区发现，然后写成：

  • (:Zone {id,label,color,ip_count,subnet_count,source,updated_at})
  • (:IP)-[:IN_ZONE]->(:Zone)          让 /api/topology/neo4j 直接读到安全域
  • (:Subnet)-[:IN_ZONE]->(:Zone)      子网按多数票归属，供 Zone 统计
  • ip.zone_id / ip.zone_label / ip.zone_color / ip.community
  • (:GDSZone {algorithm,community,label,color,ip_count,source,created_at})
    + (:IP)-[:IN_GDS_ZONE]->(:GDSZone) + ip.gds_louvain
    让 /api/topology/gds 与前端 GDS 面板在**没有 GDS 插件**的环境也能显示分区

⚠️ 关于 GDSZone 的诚实说明
    这里写入的 GDSZone **不是** Neo4j GDS 插件算出来的，而是本脚本离线算完再写入的，
    因此 `gz.source` 与 `gz.algorithm` 会如实记录算法来源（如 'offline:greedy_modularity'）。
    装好 GDS 插件后，用 `/api/analysis/gds` 重跑会覆盖这批结果。

算法选择（按可用性自动降级，并用 source 字段如实记录）
    1. louvain_communities            networkx >= 2.8，真正的 Louvain
    2. greedy_modularity_communities  networkx >= 2.0，模块度贪心（本机 2.6.3 会走这条）
    3. label_propagation_communities
    4. 连通分量
    5. subnet                        不跑图算法，直接按 /24 子网分组

用法
----
    python scripts/materialize_zones_to_neo4j.py --dry-run   # 只统计与预览，不写库
    python scripts/materialize_zones_to_neo4j.py             # 写入（默认先清理旧的 Zone/GDSZone）
    python scripts/materialize_zones_to_neo4j.py --no-clear  # 增量覆盖，不删旧数据
    python scripts/materialize_zones_to_neo4j.py --algorithm subnet
    python scripts/materialize_zones_to_neo4j.py --min-zone-size 3

凭据从项目根目录 .env.local 读取（经 scripts/env.py），脚本内不硬编码任何密码。
"""

from __future__ import annotations

import argparse
import os
import sys
from collections import Counter
from datetime import datetime, timezone

import networkx as nx
from neo4j import GraphDatabase

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from env import get_password, get_uri, get_user  # noqa: E402

# 与 scripts/import_to_neo4j.py 的 ZONE_COLORS 保持一致（前端 D3 也用这套 12 色）
ZONE_COLORS = [
    "#00d4ff", "#ff6b35", "#a855f7", "#10b981", "#f59e0b", "#ec4899",
    "#22d3ee", "#84cc16", "#f43f5e", "#8b5cf6", "#fb923c", "#06b6d4",
]

ALGO_LABELS = {
    "louvain": "Louvain",
    "greedy_modularity": "模块度贪心",
    "label_propagation": "标签传播",
    "connected_components": "连通分量",
    "subnet": "子网分组",
}


def log(msg: str) -> None:
    print(msg, flush=True)


def subnet_of(ip: str) -> str:
    parts = str(ip).split(".")
    return f"{parts[0]}.{parts[1]}.{parts[2]}.0/24" if len(parts) == 4 else "0.0.0.0/0"


def to_labels(communities) -> dict:
    """把 [{node,...}, ...] 变成 {node: community_index}"""
    labels = {}
    for idx, members in enumerate(communities):
        for node in members:
            labels[node] = idx
    return labels


def detect_communities(graph: nx.Graph, algorithm: str):
    """返回 (labels, algorithm_key)；按可用性自动降级。"""
    if algorithm in ("auto", "louvain"):
        try:
            from networkx.algorithms.community import louvain_communities

            communities = louvain_communities(graph, weight="weight", seed=42)
            return to_labels(communities), "louvain"
        except ImportError:
            if algorithm == "louvain":
                raise SystemExit(
                    "当前 networkx 没有 louvain_communities（需要 >= 2.8）；"
                    "请改用 --algorithm greedy"
                )
            log("  · networkx 无 louvain_communities，降级到 greedy_modularity")

    if algorithm in ("auto", "greedy"):
        from networkx.algorithms.community import greedy_modularity_communities

        communities = greedy_modularity_communities(graph, weight="weight")
        return to_labels(communities), "greedy_modularity"

    if algorithm == "labelprop":
        from networkx.algorithms.community import label_propagation_communities

        return to_labels(label_propagation_communities(graph)), "label_propagation"

    if algorithm == "components":
        return to_labels(nx.connected_components(graph)), "connected_components"

    raise SystemExit(f"未知算法：{algorithm}")


def read_graph(session, limit_nodes=None):
    """从库里读出 IP 节点与 CONNECTS_TO 边。"""
    node_rows = session.run(
        """
        MATCH (ip:IP)
        RETURN ip.id AS id, ip.subnet_24 AS subnet
        """
    ).data()
    ips = [r["id"] for r in node_rows if r["id"]]
    subnet_by_ip = {r["id"]: (r["subnet"] or subnet_of(r["id"])) for r in node_rows if r["id"]}

    rel_rows = session.run(
        """
        MATCH (a:IP)-[r:CONNECTS_TO]->(b:IP)
        RETURN a.id AS s, b.id AS t, coalesce(r.weight, 1) AS w
        """
    ).data()

    graph = nx.Graph()
    graph.add_nodes_from(ips)
    for r in rel_rows:
        if r["s"] and r["t"] and r["s"] != r["t"]:
            graph.add_edge(r["s"], r["t"], weight=float(r["w"] or 1))

    return ips, subnet_by_ip, graph


def build_zones(ips, subnet_by_ip, labels, algorithm_key):
    """把 community 标签整理成 Zone 记录（按规模降序重新编号，保证可重复）。"""
    groups = {}
    for ip in ips:
        groups.setdefault(labels.get(ip, -1), []).append(ip)

    ordered = sorted(groups.values(), key=lambda members: (-len(members), min(members)))

    zones = []
    ip_rows = []
    subnet_votes = {}
    prefix = "" if algorithm_key == "subnet" else "社区"

    for idx, members in enumerate(ordered):
        zone_id = f"zone_{algorithm_key}_{idx}"
        members_sorted = sorted(members)
        subnet_counter = Counter(subnet_by_ip.get(ip, subnet_of(ip)) for ip in members_sorted)
        top_subnet, _ = subnet_counter.most_common(1)[0]
        label = f"{prefix}{idx} · {top_subnet} · {len(members_sorted)}台"
        color = ZONE_COLORS[idx % len(ZONE_COLORS)]

        zones.append({
            "id": zone_id,
            "label": label,
            "color": color,
            "ip_count": len(members_sorted),
            "subnet_count": len(subnet_counter),
        })
        for ip in members_sorted:
            ip_rows.append({
                "ip_id": ip,
                "zone_id": zone_id,
                "zone_label": label,
                "zone_color": color,
                "community": idx,
            })
            subnet_votes.setdefault(subnet_by_ip.get(ip, subnet_of(ip)), []).append(idx)

    # 子网按多数票归属（与 import_to_neo4j.py 的 _majority_zone 一致）
    subnet_rows = []
    for cidr, votes in subnet_votes.items():
        winner = Counter(votes).most_common(1)[0][0]
        subnet_rows.append({"cidr": cidr, "zone_id": f"zone_{algorithm_key}_{winner}"})

    return zones, ip_rows, subnet_rows


def materialize(session, zones, ip_rows, subnet_rows, algorithm_key, clear):
    now = datetime.now(timezone.utc).isoformat()
    source = f"offline:{algorithm_key}"

    if clear:
        session.run("MATCH (:IP)-[r:IN_ZONE]->(:Zone) DELETE r")
        session.run("MATCH (:Subnet)-[r:IN_ZONE]->(:Zone) DELETE r")
        session.run("MATCH (z:Zone) DETACH DELETE z")
        session.run("MATCH (:IP)-[r:IN_GDS_ZONE]->(:GDSZone) DELETE r")
        session.run("MATCH (gz:GDSZone) DETACH DELETE gz")
        session.run("MATCH (ip:IP) REMOVE ip.gds_louvain")
        log("  · 已清理旧的 Zone / IN_ZONE / GDSZone / ip.gds_louvain")

    session.run(
        "CREATE CONSTRAINT zone_id_unique IF NOT EXISTS FOR (n:Zone) REQUIRE n.id IS UNIQUE"
    )

    session.run(
        """
        UNWIND $rows AS r
        MERGE (z:Zone {id: r.id})
        SET z.label = r.label, z.color = r.color, z.ip_count = r.ip_count,
            z.subnet_count = r.subnet_count, z.source = $source, z.updated_at = $now
        """,
        rows=zones,
        source=source,
        now=now,
    )

    session.run(
        """
        UNWIND $rows AS r
        MATCH (ip:IP {id: r.ip_id}), (z:Zone {id: r.zone_id})
        MERGE (ip)-[:IN_ZONE]->(z)
        SET ip.zone_id = r.zone_id, ip.zone_label = r.zone_label,
            ip.zone_color = r.zone_color, ip.community = r.community
        """,
        rows=ip_rows,
    )

    session.run(
        """
        UNWIND $rows AS r
        MATCH (sn:Subnet {cidr: r.cidr}), (z:Zone {id: r.zone_id})
        MERGE (sn)-[:IN_ZONE]->(z)
        """,
        rows=subnet_rows,
    )

    # GDSZone（离线计算，source 如实标注）
    gds_rows = [
        {
            "algorithm": algorithm_key,
            "community": idx,
            "label": z["label"],
            "color": z["color"],
            "ip_count": z["ip_count"],
        }
        for idx, z in enumerate(zones)
    ]
    session.run(
        """
        UNWIND $rows AS r
        MERGE (gz:GDSZone {algorithm: r.algorithm, community: r.community})
        SET gz.label = r.label, gz.color = r.color, gz.ip_count = r.ip_count,
            gz.source = $source, gz.created_at = $now
        """,
        rows=gds_rows,
        source=source,
        now=now,
    )

    gds_members = [
        {"ip_id": r["ip_id"], "algorithm": algorithm_key, "community": r["community"]}
        for r in ip_rows
    ]
    session.run(
        """
        UNWIND $rows AS r
        MATCH (ip:IP {id: r.ip_id}), (gz:GDSZone {algorithm: r.algorithm, community: r.community})
        MERGE (ip)-[:IN_GDS_ZONE]->(gz)
        SET ip.gds_louvain = r.community
        """,
        rows=gds_members,
    )

    return source


def main() -> int:
    parser = argparse.ArgumentParser(description="把 Zone / GDSZone 实体化写回 Neo4j")
    parser.add_argument("--dry-run", action="store_true", help="只统计与预览，不写库")
    parser.add_argument("--no-clear", action="store_true", help="不清理旧的 Zone / GDSZone")
    parser.add_argument(
        "--algorithm",
        default="auto",
        choices=["auto", "louvain", "greedy", "labelprop", "components", "subnet"],
        help="社区发现算法（默认 auto：按 networkx 能力自动选）",
    )
    parser.add_argument("--min-zone-size", type=int, default=1,
                        help="小于该规模的社区会被报告出来（默认 1 = 不处理）")
    parser.add_argument("--uri", default=None)
    parser.add_argument("--user", default=None)
    parser.add_argument("--password", default=None)
    args = parser.parse_args()

    uri = args.uri or get_uri()
    user = args.user or get_user()
    password = args.password or get_password()

    log(f"连接 Neo4j：{uri}（user={user}）")
    driver = GraphDatabase.driver(uri, auth=(user, password))

    try:
        with driver.session() as session:
            ips, subnet_by_ip, graph = read_graph(session)
            log(f"读入：{len(ips)} 个 IP，{graph.number_of_edges()} 条 CONNECTS_TO")

            if not ips:
                log("库里没有 :IP 节点，先导入数据再跑本脚本。")
                return 1

            if args.algorithm == "subnet":
                subnet_ids = {}
                labels = {}
                for ip in ips:
                    sn = subnet_by_ip.get(ip, subnet_of(ip))
                    subnet_ids.setdefault(sn, len(subnet_ids))
                    labels[ip] = subnet_ids[sn]
                algorithm_key = "subnet"
            else:
                labels, algorithm_key = detect_communities(graph, args.algorithm)

            log(f"算法：{ALGO_LABELS.get(algorithm_key, algorithm_key)}")

            zones, ip_rows, subnet_rows = build_zones(ips, subnet_by_ip, labels, algorithm_key)

            sizes = sorted((z["ip_count"] for z in zones), reverse=True)
            singletons = sum(1 for s in sizes if s == 1)
            log(f"分区：{len(zones)} 个 Zone；最大 {sizes[0]} 台；单节点域 {singletons} 个")

            try:
                from networkx.algorithms.community import modularity

                grouped = {}
                for ip in ips:
                    grouped.setdefault(labels.get(ip, -1), set()).add(ip)
                q = modularity(graph, list(grouped.values()), weight="weight")
                log(f"模块度 Q = {q:.4f}（越接近 0 说明图本身越没有社区结构）")
            except Exception as exc:  # noqa: BLE001
                log(f"模块度计算跳过：{exc}")

            if args.min_zone_size > 1:
                small = [z for z in zones if z["ip_count"] < args.min_zone_size]
                if small:
                    log(f"⚠ 有 {len(small)} 个 Zone 小于 --min-zone-size={args.min_zone_size}"
                        "（本脚本不会自动合并，仅提示）")

            log("前 5 个 Zone：")
            for z in zones[:5]:
                log(f"  · {z['id']}  {z['label']}  ({z['ip_count']} 台 / {z['subnet_count']} 子网)")

            if args.dry_run:
                log("\n--dry-run：未写入任何数据。")
                return 0

            source = materialize(
                session,
                zones,
                ip_rows,
                subnet_rows,
                algorithm_key,
                clear=not args.no_clear,
            )
            log(f"\n写入完成：source={source}")
            log("提示：写入的 GDSZone 是**离线计算**结果，不是 Neo4j GDS 插件产出的；"
                "装好 GDS 后可用 /api/analysis/gds 重跑覆盖。")
            log("验证：curl -s localhost:5000/api/health?deep=1  然后刷新前端「从 Neo4j 加载数据」")
            return 0
    finally:
        driver.close()


if __name__ == "__main__":
    sys.exit(main())
