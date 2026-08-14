"""
Enricher 包入口

⚠️ 必须在这里 import 所有 enricher 模块，@enricher 装饰器才会触发注册。
   新增 enricher 时，记得在这里加一行 import。
"""
from .base import BaseEnricher, safe_result
from .registry import (
    enricher, REGISTRY, get, list_enrichers, iter_instances, reset_for_tests,
)
from .config import Config
from .types import (
    Entity, IPEntity, SubnetEntity, ZoneEntity, DomainEntity, ServiceEntity,
    EnrichmentResult, ENTITY_TYPES,
)
from .pipeline import Pipeline, PipelineResult

# ---- 显式 import 所有 enricher 模块，触发 @enricher 注册 ----
from . import ip_geo          # noqa: F401  → IPGeoEnricher
from . import service_type    # noqa: F401  → ServiceTypeEnricher
from . import port_service    # noqa: F401  → PortServiceEnricher
from . import subnet_cidr     # noqa: F401  → SubnetCIDREnricher
from . import anomaly_score   # noqa: F401  → AnomalyScoreEnricher

__all__ = [
    "BaseEnricher", "safe_result",
    "enricher", "REGISTRY", "get", "list_enrichers", "iter_instances", "reset_for_tests",
    "Config",
    "Entity", "IPEntity", "SubnetEntity", "ZoneEntity", "DomainEntity", "ServiceEntity",
    "EnrichmentResult", "ENTITY_TYPES",
    "Pipeline", "PipelineResult",
]
