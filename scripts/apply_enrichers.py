#!/usr/bin/env python3
"""
独立丰富器脚本（v2 — 调 Pipeline）

用法:
    python apply_enrichers.py [输入 JSON] [输出 JSON]

默认:
    输入  = topology_data.json(2)
    输出  = topology_data_enriched.json
    配置  = config/enrichers.yaml

行为：
    1. 读 JSON → 跑 Pipeline → 写回 JSON
    2. Pipeline 会自动：
       - 给每个 IP 加 geo_country / service_type / anomaly_score_enriched
       - 生成 Service 节点 + RUNS 关系
       - 归一化 anomaly_score
    3. 输出 JSON 里新增 enricher_meta + enricher_services + enricher_relationships
"""
import json
import sys
from pathlib import Path

# 确保能 import scripts.enrichers
sys.path.insert(0, str(Path(__file__).parent))

from enrichers import Pipeline, Config


def apply_enrichers_to_json(input_path, output_path, config_path="config/enrichers.yaml"):
    print("=" * 60)
    print("JSON 数据丰富器 (v2 Pipeline)")
    print("=" * 60)
    print(f"输入：{input_path}")
    print(f"输出：{output_path}")
    print(f"配置：{config_path}")
    print()

    # 读 JSON
    with open(input_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    nodes = data.get("nodes", [])
    links = data.get("links", [])
    print(f"📦 加载 {len(nodes)} 节点 / {len(links)} 边")

    # 跑 Pipeline
    cfg = Config.from_yaml(config_path)
    pl = Pipeline(cfg)
    print(f"⚙️  启用 enricher: {list(pl._enricher_pool.keys())}")
    print()

    res = pl.run(nodes, links)

    # 把 enriched entities 写回 JSON
    # 1) 更新 nodes：以原始节点为基础 merge enriched 字段，
    #    避免重建时丢失 role_guess / zone_id / anomaly_level 等已有字段
    original_by_id = {n["id"]: n for n in nodes if n.get("type", "IP") == "IP"}
    enriched_nodes = []
    for ip in res.ips:
        n = dict(original_by_id.get(ip.id, {}))
        n.update({
            "id": ip.id,
            "name": ip.id,
            "ip": ip.ip,
            "subnet_24": ip.subnet_24,
            "community": ip.community,
            "degree": ip.degree,
            "in_degree": ip.in_degree,
            "out_degree": ip.out_degree,
            "ports": ip.ports,
            "protocols": ip.protocols,
            "is_hub": ip.is_hub,
            "anomaly_score": ip.anomaly_score,
            "anomaly_score_enriched": ip.anomaly_score_enriched,
            "service_type": ip.service_type,
            "service_confidence": ip.service_confidence,
            "geo": {
                "country": ip.geo_country,
                "city": ip.geo_city,
                "isp": ip.geo_isp,
                "org": ip.geo_org,
            },
            "enricher_chain": ip.enricher_chain,
        })
        enriched_nodes.append(n)

    # 2) 追加 Service 节点
    for svc in res.services:
        enriched_nodes.append({
            "id": svc.id,
            "type": "Service",
            "name": svc.name,
            "port": svc.port,
            "protocol": svc.protocol,
            "category": svc.category,
        })

    data["nodes"] = enriched_nodes
    data["enricher_relationships"] = res.new_relationships
    data["enricher_stats"] = res.enricher_stats

    # 保存
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    print()
    print(f"✅ 完成！写入 {output_path}")
    print(f"📊 统计:")
    print(f"   IPs:          {len(res.ips)}")
    print(f"   Services:     {len(res.services)}")
    print(f"   New rels:     {len(res.new_relationships)}")
    print()
    print("📊 enricher 统计:")
    name_w = max(len(n) for n in res.enricher_stats) if res.enricher_stats else 10
    for n, s in sorted(res.enricher_stats.items()):
        print(f"   {n.ljust(name_w)}  scanned={s['scanned']:>4}  ok={s['succeeded']:>4}  err={s['errors']:>3}  ({s['duration_ms']}ms)")


if __name__ == "__main__":
    input_path = sys.argv[1] if len(sys.argv) > 1 else "topology_data.json(2)"
    output_path = sys.argv[2] if len(sys.argv) > 2 else "topology_data_enriched.json"
    config_path = sys.argv[3] if len(sys.argv) > 3 else "config/enrichers.yaml"

    if not Path(input_path).exists():
        print(f"❌ 文件不存在：{input_path}")
        sys.exit(1)

    apply_enrichers_to_json(input_path, output_path, config_path)
