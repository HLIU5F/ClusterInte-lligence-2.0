# -*- coding: utf-8 -*-
"""生成完全合成的演示拓扑数据（public/topology_demo.json）。

用途：真实网络数据已从仓库移除，fresh clone 后应用没有任何数据可加载。
本脚本生成一份 IP 全部来自 RFC 5737 文档保留段（192.0.2.0/24、
198.51.100.0/24、203.0.113.0/24）的合成拓扑，结构与真实数据一致，
可安全入库、可公开。

用法：
    python scripts/generate_demo_data.py
    python scripts/generate_demo_data.py --nodes 300 --seed 7
"""
import argparse
import json
import os
import random
from datetime import datetime, timezone

# RFC 5737 文档专用网段：绝不可能与真实内网冲突
SUBNETS = ["192.0.2", "198.51.100", "203.0.113"]
ROLE_POOL = [
    ("web_server", [80, 443]),
    ("database", [3306, 5432]),
    ("cache", [6379]),
    ("message_queue", [9092, 5672]),
    ("monitoring", [36000, 9100]),
    ("load_balancer", [80, 443, 8080]),
    ("dns_server", [53]),
    ("api_gateway", [8080, 8443]),
    ("bastion_host", [22]),
    ("unknown", [22, 3389]),
]
SERVICE_TYPES = ["Web", "Database", "Cache", "MQ", "Monitoring", "Gateway", "Host"]


def build(nodes_target: int, seed: int):
    rng = random.Random(seed)
    nodes, links = [], []

    # 3 个采集/汇聚型枢纽（演示数据里也保留这一结构，便于展示安全域折叠）
    collectors = []
    for i, subnet in enumerate(SUBNETS):
        ip = f"{subnet}.10"
        collectors.append(ip)

    # 业务节点：按子网均匀分布
    workers = []
    per_subnet = max(1, (nodes_target - len(collectors)) // len(SUBNETS))
    counter = 20
    for subnet in SUBNETS:
        for _ in range(per_subnet):
            workers.append(f"{subnet}.{counter}")
            counter += 1
            if counter > 250:
                counter = 20

    # 边：枢纽 → 业务节点（星型汇聚），再补一点业务节点之间的横向连接
    for subnet, collector in zip(SUBNETS, collectors):
        members = [w for w in workers if w.startswith(subnet + ".")]
        for member in members:
            port = rng.choice([36000, 9100, 53, 443, 9092])
            links.append({
                "source": collector, "target": member, "weight": rng.randint(1, 40),
                "bytes": rng.randint(1024, 5_000_000),
                "ports": [port], "protocols": ["tcp"],
            })
    # 横向业务边（占比约 25%）
    for _ in range(max(1, len(workers) // 4)):
        a, b = rng.sample(workers, 2)
        if a.split(".")[:3] == b.split(".")[:3]:
            continue
        links.append({
            "source": a, "target": b, "weight": rng.randint(1, 10),
            "bytes": rng.randint(512, 200_000),
            "ports": [rng.choice([80, 443, 3306, 6379, 9092])], "protocols": ["tcp"],
        })

    degree = {n: [0, 0] for n in collectors + workers}  # [in, out]
    for link in links:
        degree[link["target"]][0] += 1
        degree[link["source"]][1] += 1

    all_ips = collectors + workers
    for ip in all_ips:
        in_d, out_d = degree[ip]
        role, ports = rng.choice(ROLE_POOL)
        is_collector = ip in collectors
        if is_collector:
            role, ports = "monitoring", [36000, 9100]
        score = round(min(0.99, max(0.01, rng.gauss(0.72 if is_collector else 0.18, 0.12))), 4)
        level = "Critical" if score > 0.75 else "High" if score > 0.60 else "Medium" if score > 0.45 else "Low"
        nodes.append({
            "id": ip,
            "label": ip,
            "community": 0,
            "degree": in_d + out_d,
            "in_degree": in_d,
            "out_degree": out_d,
            "business_degree": max(0, in_d + out_d - (len(workers) if is_collector else 0)),
            "port_count": len(ports),
            "ports": ports,
            "protocols": ["tcp"],
            "anomaly_score": score,
            "anomaly_level": level,
            "is_anomaly": score > 0.60,
            "is_whitelisted": False,
            "whitelist_reason": "",
            "service_type": rng.choice(SERVICE_TYPES),
            "subnet_24": f"{ip.rsplit('.', 1)[0]}.0/24",
            "role_guess": role,
            "is_hub": is_collector,
            "is_critical": role in ("database", "dns_server"),
            "zone_id": str(1 + (hash(ip.rsplit(".", 1)[0]) % 5)),
            "zone_color": "#00d4ff",
            "zone_label": f"演示安全域 {1 + (hash(ip.rsplit('.', 1)[0]) % 5)}",
        })

    # 用连通分量给一个初始 community（便于前端在未聚类时也有颜色）
    for idx, node in enumerate(nodes):
        node["community"] = idx % 12

    metadata = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "demo_synthetic_rfc5737",
        "note": "合成演示数据，IP 取自 RFC 5737 文档保留段，不含任何真实网络信息",
        "total_nodes": len(nodes),
        "total_links": len(links),
        "communities": 12,
        "modularity": None,
        "resolution_used": 1.0,
        "min_community_size": 2,
    }
    domain_names = {str(i): f"演示安全域 {i + 1}" for i in range(12)}
    return {"metadata": metadata, "nodes": nodes, "links": links, "domainNames": domain_names}


def main():
    parser = argparse.ArgumentParser(description="生成合成演示拓扑数据")
    parser.add_argument("--nodes", type=int, default=212, help="节点总数（默认 212，与真实核心图规模一致）")
    parser.add_argument("--seed", type=int, default=20260918, help="随机种子（保证可复现）")
    parser.add_argument("--out", default=os.path.join("public", "topology_demo.json"))
    args = parser.parse_args()

    data = build(args.nodes, args.seed)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    print("已生成 %s：%d 节点 / %d 边（全部为 RFC 5737 合成 IP）"
          % (args.out, len(data["nodes"]), len(data["links"])))


if __name__ == "__main__":
    main()
