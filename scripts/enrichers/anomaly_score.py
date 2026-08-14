"""
anomaly_score enricher
基于度中心性 + 端口暴露数 + is_hub 的简单异常评分 (raw 值)

Pipeline 在所有 enricher 跑完后调 normalize_anomaly_scores() 归一到 [0, 1]。

公式（raw，单节点可以算）：
  score = degree + 5 * is_hub + 2 * open_port_count
即：度大 + 是 hub + 开放端口多 → 异常。
跨域连接数留给后续 P2b 加（数据需要先跑一遍 GDS WCC / cross-domain）。
"""
from __future__ import annotations
from typing import List, TYPE_CHECKING

from .base import BaseEnricher, safe_result
from .registry import enricher
from .types import IPEntity, EnrichmentResult

if TYPE_CHECKING:
    pass


@enricher
class AnomalyScoreEnricher(BaseEnricher):
    name = "anomaly_score"
    category = "Risk"
    description = "基于度中心性 + is_hub + 开放端口数 的异常评分（pipeline 末尾归一化）"
    applicable_type = "IP"

    def postprocess(self, raw, entity: IPEntity) -> EnrichmentResult:
        score_raw = (
            entity.degree
            + 5 * (1 if getattr(entity, "is_hub", False) else 0)
            + 2 * len(entity.ports)
        )
        return safe_result(properties={
            "anomaly_score_enriched": float(score_raw),
        })


def normalize_anomaly_scores(ips: List[IPEntity]) -> None:
    """
    Pipeline 在所有 enricher 跑完之后调用。
    把 anomaly_score_enriched 归一化到 [0, 1]。
    """
    vals = []
    for ip in ips:
        v = getattr(ip, "anomaly_score_enriched", None)
        if isinstance(v, (int, float)):
            vals.append(v)
    if not vals:
        return
    lo, hi = min(vals), max(vals)
    spread = (hi - lo) or 1
    for ip in ips:
        v = getattr(ip, "anomaly_score_enriched", None)
        if isinstance(v, (int, float)):
            ip.anomaly_score_enriched = round((v - lo) / spread, 4)
