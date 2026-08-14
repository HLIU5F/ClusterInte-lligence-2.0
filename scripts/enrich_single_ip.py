"""
单节点 Enricher 执行入口

由 /api/enrich 路由调用，对单个 IP 执行指定的 enricher。

用法：
  python scripts/enrich_single_ip.py --ip 10.20.3.25
  python scripts/enrich_single_ip.py --ip 10.20.3.25 --enricher ip_geo
  python scripts/enrich_single_ip.py --ip 10.20.3.25 --enricher port_service
  python scripts/enrich_single_ip.py --list   # 列出可用 enricher

输出：JSON → stdout
"""
from __future__ import annotations
import argparse
import json
import sys
import os

# 确保 scripts 目录在 Python 路径中
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from enrichers.pipeline import Pipeline, _ip_from_dict
from enrichers.config import Config
from enrichers.registry import list_enrichers


def list_available_enrichers():
    """列出所有可用 enricher 信息"""
    config_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config", "enrichers.yaml")
    config = Config.from_yaml(config_path if os.path.exists(config_path) else None)
    enabled_names = {name for name, _ in config.enabled_enrichers()}

    enrichers = []
    for cls in list_enrichers(enabled_only=False):
        enrichers.append({
            "name": cls.name,
            "category": cls.category,
            "applicable_type": cls.applicable_type,
            "enabled": cls.name in enabled_names,
            "description": cls.description,
        })
    return {"enrichers": enrichers}


def enrich_single_ip(ip: str, enricher_name: str | None = None, node_input: dict | None = None) -> dict:
    """
    对单个 IP 执行 enricher

    Args:
        ip: 目标 IP 地址
        enricher_name: 指定 enricher 名称，None 则运行所有启用的 enricher

    Returns:
        dict: {ip, enriched, properties, relationships, errors, enricher_stats}
    """
    # 1. 加载配置
    config_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config", "enrichers.yaml")
    config = Config.from_yaml(config_path if os.path.exists(config_path) else None)

    # 2. 构造单个 IP 的节点输入
    if node_input is None:
        node_input = {
            "id": ip,
            "type": "IP",
            "ip": ip,
            "degree": 0,
            "in_degree": 0,
            "out_degree": 0,
            "ports": [],
            "community": -1,
            "anomaly_score": 0.0,
            "protocols": [],
        }
    node_input["id"] = ip
    node_input["ip"] = ip
    node_input.setdefault("type", "IP")
    node_input["ports"] = [int(p) for p in (node_input.get("ports") or [])]
    node_input["protocols"] = list(node_input.get("protocols") or [])

    # 3. 创建 pipeline 并运行
    pipeline = Pipeline(config)

    # 如果指定了 enricher，临时只启用那一个
    if enricher_name:
        if enricher_name not in pipeline._enricher_pool:
            available = list(pipeline._enricher_pool.keys())
            return {
                "ip": ip,
                "enriched": False,
                "error": f"Enricher '{enricher_name}' 未找到或已禁用。可用: {available}",
            }
        # 临时过滤，只保留指定的 enricher
        pipeline._enricher_pool = {
            name: inst for name, inst in pipeline._enricher_pool.items()
            if name == enricher_name
        }

    result = pipeline.run([node_input])

    # 4. 提取结果
    enriched_ip = result.ips[0] if result.ips else None

    if not enriched_ip:
        return {
            "ip": ip,
            "enriched": False,
            "error": "Pipeline 未返回结果",
            "enricher_stats": result.enricher_stats,
        }

    # 5. 构造输出
    # 使用 model_dump() 安全序列化 Pydantic 模型
    base_fields = {"id", "ip", "enricher_chain", "subnet_24"}
    raw = enriched_ip.model_dump()
    properties = {k: v for k, v in raw.items() if k not in base_fields and v is not None and v != "" and v != 0 and v != 0.0 and v != []}

    return {
        "ip": ip,
        "enriched": True,
        "properties": properties,
        "enricher_chain": enriched_ip.enricher_chain or [],
        "new_services": [
            {
                "id": s.id,
                "name": s.name,
                "port": s.port,
                "protocol": s.protocol,
                "confidence": getattr(s, "confidence", None),
            }
            for s in result.services
        ],
        "new_relationships": result.new_relationships,
        "enricher_stats": result.enricher_stats,
        "errors": result.errors,
    }


def main():
    parser = argparse.ArgumentParser(description="单节点 Enricher 执行器")
    parser.add_argument("--ip", help="要 enrich 的 IP 地址")
    parser.add_argument("--enricher", help="指定 enricher 名称（不传则跑所有启用的）")
    parser.add_argument("--list", action="store_true", help="列出可用 enricher")
    parser.add_argument("--node-json", default=None, help="可选：节点已有属性 JSON，用于单点 enrich 复用端口/度数")
    args = parser.parse_args()

    if args.list:
        result = list_available_enrichers()
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    if not args.ip:
        print(json.dumps({"error": "请提供 --ip 参数"}), file=sys.stderr)
        sys.exit(1)

    node_input = json.loads(args.node_json) if args.node_json else None
    try:
        result = enrich_single_ip(args.ip, args.enricher, node_input)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as e:
        print(json.dumps({
            "ip": args.ip,
            "enriched": False,
            "error": str(e),
        }, ensure_ascii=False, indent=2), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
