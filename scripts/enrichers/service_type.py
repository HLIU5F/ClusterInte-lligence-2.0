"""
服务类型推断 enricher（从端口集合 → 大类）

旧的 service_type.py 把 SERVICE_MAP 写死在类上。新版：
- 类别目录可继承改动
- 置信度 = (命中端口数 / 词典端口数) 取最高
- min_confidence 阈值参数化
"""
from __future__ import annotations
from typing import Set, Dict, Tuple

from .base import BaseEnricher, safe_result
from .registry import enricher
from .types import IPEntity, EnrichmentResult


@enricher
class ServiceTypeEnricher(BaseEnricher):
    name = "service_type"
    category = "Service"
    description = "从开放端口集合推断服务大类（Web / DB / Cache / RemoteAccess / MQ …）"
    applicable_type = "IP"

    # 端口词典：{ (frozenset 端口) -> 类别名 }
    SERVICE_MAP: Dict[frozenset, str] = {
        frozenset({80, 443, 8080, 8443, 8000, 8888}): "Web",
        frozenset({3306, 5432, 1521, 1433, 27017, 6379}): "Database",
        frozenset({6379, 11211, 6380, 11212}): "Cache",
        frozenset({9092, 9093, 9094, 2181, 5672, 15672, 61613, 61616}): "MQ",
        frozenset({22, 3389, 5900, 5985}): "RemoteAccess",
        frozenset({53, 88, 389, 636}): "Infra",
        frozenset({25, 110, 143, 993, 995, 465, 587}): "Mail",
        frozenset({514, 1514, 601, 6514}): "Logging",
        frozenset({8086, 9200, 9300, 9090, 9100}): "Monitoring",
        frozenset({5000, 5001, 6000, 6001, 7443}): "Storage",
    }

    min_confidence: float = 0.15   # 调阈值

    def _infer(self, ports: Set[int]) -> Tuple[str, float]:
        best_match = None
        best_score = 0.0
        for port_set, name in self.SERVICE_MAP.items():
            if not ports or not port_set:
                continue
            hit = len(ports & port_set)
            if hit == 0:
                continue
            # precision: IP 端口有多少命中了这个类别
            precision = hit / len(ports)
            # coverage: 词典被覆盖多少
            coverage = hit / len(port_set)
            # 取较大值，让单个端口也能匹配
            score = max(precision, coverage)
            if score > best_score:
                best_score = score
                best_match = name
        return (best_match or "未知"), round(best_score, 2)

    def postprocess(self, raw, entity: IPEntity) -> EnrichmentResult:
        ports: Set[int] = set()
        for p in entity.ports or []:
            try:
                ports.add(int(p))
            except (TypeError, ValueError):
                continue
        ports = {p for p in ports if p > 0}

        if not ports:
            return safe_result(properties={
                "service_type": "未知",
                "service_confidence": 0.0,
            })

        service, confidence = self._infer(ports)
        if confidence < self.min_confidence:
            service = "未知"
        return safe_result(properties={
            "service_type": service,
            "service_confidence": confidence,
        })
