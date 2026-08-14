"""
Pipeline 编排器

# 输入
nodes:  List[dict]  from preprocess.py
links:  List[dict]  from preprocess.py
config: Config (default → 全开)

# 处理
1. 转 Pydantic entities（按 "id" 起始字符串 + heuristic 决定 type）
2. 按 applicable_type 分桶 → 每个桶里按 registered-order 跑 enricher
3. 跑完所有 IP 后调 normalize_anomaly_scores()
4. new_entities 进下一轮 (depth-limit)

# 输出
PipelineResult
  .ips:          List[IPEntity]
  .subnets:      List[SubnetEntity]
  .zones:        List[ZoneEntity]
  .services:     List[ServiceEntity]
  .domains:      List[DomainEntity]
  .new_relationships: List[dict]   # {source_id, type, target_id, target_type, props?}
  .enricher_stats:  Dict[name -> stats]
  .errors:           List[str]
"""
from __future__ import annotations
import logging
from collections import defaultdict
from typing import Dict, List, Any, Type, Iterable, Callable, Optional
from time import time

from .base import BaseEnricher
from .registry import REGISTRY, list_enrichers
from .types import (
    Entity, IPEntity, SubnetEntity, ZoneEntity, DomainEntity, ServiceEntity,
    EnrichmentResult, ENTITY_TYPES,
)
from .config import Config
from .anomaly_score import normalize_anomaly_scores

logger = logging.getLogger(__name__)


# ---------- 工具：从 dict 构造 entity ----------

def _ip_from_dict(n: dict) -> IPEntity:
    # 兼容 geo 字段嵌套
    geo = n.get("geo") or {}
    return IPEntity(
        id=n["id"],
        ip=n.get("ip") or n["id"],
        subnet_24=n.get("subnet_24"),
        degree=n.get("degree", 0),
        in_degree=n.get("in_degree", 0),
        out_degree=n.get("out_degree", 0),
        ports=list(n.get("ports") or []),
        community=n.get("community", -1),
        anomaly_score=n.get("anomaly_score", 0.0),
        is_hub=n.get("is_hub", False),
        protocols=list(n.get("protocols") or []),
        geo_country=geo.get("country"),
        geo_city=geo.get("city"),
        geo_isp=geo.get("isp"),
        geo_org=geo.get("org"),
        service_type=n.get("service_type"),
        service_confidence=n.get("service_confidence", 0.0),
        role_guess=n.get("role_guess"),
        anomaly_level=n.get("anomaly_level"),
        zone_id=n.get("zone_id"),
        zone_label=n.get("zone_label"),
        is_core_infra=bool(n.get("is_core_infra", False)),
        domain_source=n.get("domain_source"),
        business_degree=float(n.get("business_degree", 0) or 0),
    )


def _subnet_from_dict(n: dict) -> SubnetEntity:
    cidr = n.get("cidr") or n["id"]
    net_size = 0
    return SubnetEntity(
        id=cidr,
        cidr=cidr,
        ip_count=n.get("ip_count", 0),
    )


def _zone_from_dict(n: dict) -> ZoneEntity:
    zid = str(n.get("zone_id") or n.get("id"))
    return ZoneEntity(
        id=zid,
        zone_id=zid,
        label=n.get("label") or f"Zone {zid}",
        color=n.get("color"),
        ip_count=n.get("ip_count", 0),
    )


# ---------- 结果 ----------

class PipelineResult:
    def __init__(self):
        self.ips: List[IPEntity] = []
        self.subnets: List[SubnetEntity] = []
        self.zones: List[ZoneEntity] = []
        self.services: List[ServiceEntity] = []
        self.domains: List[DomainEntity] = []
        self.new_relationships: List[Dict[str, Any]] = []
        self.errors: List[str] = []
        self.enricher_stats: Dict[str, Dict[str, int]] = {}

    def all_entities(self) -> Iterable[Entity]:
        yield from self.services
        yield from self.subnets
        yield from self.zones
        yield from self.ips   # IP 放最后，让上层的更先被看到
        yield from self.domains

    def entity_count(self) -> int:
        return len(self.ips) + len(self.subnets) + len(self.zones) + len(self.services) + len(self.domains)


# ---------- Pipeline ----------

class Pipeline:
    def __init__(self, config: Optional[Config] = None):
        self.config = config or Config.from_yaml(None)
        self._enricher_pool: Dict[str, BaseEnricher] = {}
        self._enricher_meta: Dict[str, Type[BaseEnricher]] = {}
        self._build_pool()

    def _build_pool(self):
        """按 config 把启用的 enricher 实例化"""
        from .config import Config as _Config  # noqa
        conf = self.config
        for name, params in conf.enabled_enrichers():
            cls = REGISTRY.get(name)
            if cls is None:
                logger.warning("config 引用了未注册的 enricher: %s", name)
                continue
            inst = cls()
            # 把 params 里的覆盖塞给实例
            for k, v in (params or {}).items():
                if hasattr(inst, k):
                    setattr(inst, k, v)
                else:
                    logger.warning("enricher %s 没有参数 %s，忽略", name, k)
            self._enricher_pool[name] = inst
            self._enricher_meta[name] = cls

    # ----- 主入口 -----

    def run(self, nodes: List[dict], links: List[dict] | None = None) -> PipelineResult:
        """
        nodes: 标准 preprocess 出来的 nodes 列表
        links: 留着（暂未消费，给后续 cross-domain 用）
        """
        result = PipelineResult()
        t0 = time()

        # 1) 转 Pydantic；先把所有东西按 id 索引
        entities_by_id: Dict[str, Entity] = {}
        # type_ → 处理函数
        converters = {
            "IP": (result.ips, _ip_from_dict),
            "Subnet": (result.subnets, _subnet_from_dict),
            "Zone": (result.zones, _zone_from_dict),
        }

        for n in nodes:
            ntype = n.get("type", "IP")  # 默认 IP（兼容旧数据）
            if ntype not in converters:
                continue
            bucket, conv = converters[ntype]
            ent = conv(n)
            bucket.append(ent)
            entities_by_id[ent.id] = ent

        # 2) 按 applicable_type 分桶 enricher
        by_type: Dict[str, List[BaseEnricher]] = defaultdict(list)
        for name, inst in self._enricher_pool.items():
            by_type[inst.applicable_type].append(inst)
            # 累计每个 enricher 的初始 stats
            self._enricher_meta[name].last_stats = {
                "scanned": 0, "succeeded": 0, "errors": 0, "duration_ms": 0
            }

        # 3) 跑 enricher；用 BFS 让 new_entities 进下一轮（深度限制 2）
        pending_by_type: Dict[str, List[Entity]] = defaultdict(list)
        pending_by_type["IP"] = list(result.ips)
        pending_by_type["Subnet"] = list(result.subnets)
        pending_by_type["Zone"] = list(result.zones)

        depth = 0
        max_depth = 2
        while any(pending_by_type.values()) and depth <= max_depth:
            depth += 1
            # 当前轮要跑
            current_round: List[Entity] = []
            for t, entities in pending_by_type.items():
                current_round.extend(entities)
            pending_by_type = defaultdict(list)

            for ent in current_round:
                key = self._entity_label(ent)
                enrichers = by_type.get(key, [])
                if not enrichers:
                    continue
                for enricher in enrichers:
                    self._run_one(enricher, ent, entities_by_id, result, pending_by_type)

            # 收集此轮新生成的 entity 进下一轮 BFS
            for t, entities in pending_by_type.items():
                for e in entities:
                    entities_by_id[e.id] = e

        # 4) 后置归一化
        normalize_anomaly_scores(result.ips)

        # 5) 收集 stats
        for name, cls in self._enricher_meta.items():
            result.enricher_stats[name] = dict(cls.last_stats)

        result.errors.extend([])  # 占位；enricher 报错被 enrich 吞掉 → 进 last_stats
        logger.info(
            "Pipeline done in %.2fs: %d ips, %d subnets, %d zones, %d services, %d new_rels, %d enrichers",
            time() - t0, len(result.ips), len(result.subnets), len(result.zones),
            len(result.services), len(result.new_relationships), len(self._enricher_pool),
        )
        return result

    # ----- 单条 entity × 单个 enricher -----

    def _run_one(self, enricher: BaseEnricher, ent: Entity,
                 by_id: Dict[str, Entity], result: PipelineResult,
                 pending: Dict[str, List[Entity]]):
        """跑一个 enricher 写一个 entity；outputs 进 result + pending"""
        r: EnrichmentResult = enricher.enrich(ent)

        # merge properties 到 entity（Pydantic 模型）
        for k, v in r.properties.items():
            if hasattr(ent, k):
                setattr(ent, k, v)
            else:
                logger.debug("[%s] 想写属性 %s 但 %s 不支持",
                             enricher.name, k, type(ent).__name__)
        # 记录经历的 enricher
        chain = getattr(ent, "enricher_chain", None) or []
        chain.append(enricher.name)
        ent.enricher_chain = chain

        # 把 new_entities 放到正确 bucket
        for ne in r.new_entities:
            label = self._entity_label(ne)
            if label == "Service":
                result.services.append(ne)  # type: ignore[arg-type]
            elif label == "Subnet":
                result.subnets.append(ne)  # type: ignore[arg-type]
            elif label == "Zone":
                result.zones.append(ne)  # type: ignore[arg-type]
            elif label == "Domain":
                result.domains.append(ne)  # type: ignore[arg-type]
            pending[label].append(ne)

        # 把 relationships 落 result
        for rel in r.relationships:
            # 现在所有关系都从 ent (source) 出发
            result.new_relationships.append({
                "source": ent.id,
                "type": rel["type"],
                "target": rel["target"],
                "target_type": rel.get("target_type", "Unknown"),
                "props": rel.get("props", {}),
            })

    @staticmethod
    def _entity_label(ent: Entity) -> str:
        # IPEntity -> "IP"; SubnetEntity -> "Subnet"...
        name = type(ent).__name__
        if name.endswith("Entity"):
            name = name[:-6]
        return name


# ---------- CLI 入口（dry-run 验证用） ----------

def _main():
    import argparse, json, sys
    from pathlib import Path

    ap = argparse.ArgumentParser(description="Run enricher pipeline on a topology JSON")
    ap.add_argument("--json", default="scripts/topology_data_enriched.json")
    ap.add_argument("--config", default="config/enrichers.yaml")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--list", action="store_true", help="列出注册表中的 enricher")
    args = ap.parse_args()

    if args.list:
        from .registry import list_enrichers
        rows = [("name", "category", "applicable_type", "enabled", "description")]
        for c in list_enrichers(enabled_only=False):
            rows.append((c.name, c.category, c.applicable_type, str(c.enabled), c.description))
        widths = [max(len(str(r[i])) for r in rows) for i in range(len(rows[0]))]
        for r in rows:
            print("  ".join(str(c).ljust(w) for c, w in zip(r, widths)))
        return

    cfg = Config.from_yaml(args.config)
    pl = Pipeline(cfg)
    print(f"⚙️  启用 enricher: {list(pl._enricher_pool.keys())}")
    print(f"   fail_fast={cfg.get('fail_fast')}")

    data = json.loads(Path(args.json).read_text(encoding="utf-8"))
    nodes = data.get("nodes", [])
    links = data.get("links", [])
    print(f"📦  输入 {len(nodes)} 节点 / {len(links)} 边")

    res = pl.run(nodes, links)

    print(f"✅ 完成:")
    print(f"   IPs:          {len(res.ips)}")
    print(f"   Subnets:      {len(res.subnets)}")
    print(f"   Zones:        {len(res.zones)}")
    print(f"   Services:     {len(res.services)}")
    print(f"   Domains:      {len(res.domains)}")
    print(f"   New rels:     {len(res.new_relationships)}")
    print()
    print("📊  enricher 统计:")
    name_w = max(len(n) for n in res.enricher_stats)
    for n, s in sorted(res.enricher_stats.items()):
        print(f"   {n.ljust(name_w)}  "
              f"scanned={s['scanned']:>4}  ok={s['succeeded']:>4}  err={s['errors']:>3}  "
              f"({s['duration_ms']}ms)")

    if args.dry_run:
        return
    # 真导入 Neo4j；留给 import_to_neo4j.py 接管
    print()
    print("ℹ️  --dry-run 关掉后还会输出 enriched 数据，请改用 import_to_neo4j.py 落库")


if __name__ == "__main__":
    _main()
