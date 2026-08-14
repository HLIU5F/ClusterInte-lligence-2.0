"""
BaseEnricher 抽象基类（flowsint 风格 + 简化）

约定：

1. 每个 enricher 继承 BaseEnricher
2. 类属性声明：
   - name:           str (必须)
   - category:       str (必须; 用于分桶，UI 展示)
   - description:    str (必须)
   - applicable_type: str (必须; "IP" / "Subnet" / ...)
3. 方法：
   - scan(entity) -> Any          默认就是 sync，直接 return entity; 用户可改 async
   - postprocess(raw, entity) -> EnrichmentResult
     raw      : scan() 拿回来的原始数据
     entity   : 原始 entity（已经在仓里的实例）
     return   : EnrichmentResult {properties, relationships, new_entities, errors}
4. 不需要做：
   - 不要自己写回 entity（pipeline 会统一 merge；见 EnrichmentResult.properties）
5. 错误隔离：
   - enricher 里抛异常会被 Pipeline 捕获，最终在 stats 里报错数+
   - 想主动记错 → 用 EnrichmentResult.errors[]
"""
from __future__ import annotations
import asyncio
import time
import logging
from abc import ABC, abstractmethod
from typing import Any, ClassVar, Optional, Type, List, get_args

from .types import Entity, EnrichmentResult, ENTITY_TYPES

logger = logging.getLogger(__name__)


class BaseEnricher(ABC):
    """所有 enricher 的抽象基类"""

    # ---- 元数据（子类必须设） ----
    name: ClassVar[str] = ""                      # "ip_geo"
    category: ClassVar[str] = ""                  # "Geo" / "Service" / "Network" / "Risk"
    description: ClassVar[str] = ""               # 一句话描述

    # 适用实体类型 label ("IP" / "Subnet" / ...)
    applicable_type: ClassVar[str] = "IP"

    # ---- 开关 ----
    enabled: ClassVar[bool] = True

    # ---- 统计（每次 Pipeline 跑完后由 pipeline 写入） ----
    last_stats: ClassVar[dict] = {
        "scanned": 0,
        "succeeded": 0,
        "errors": 0,
        "duration_ms": 0,
    }

    @classmethod
    def input_model(cls) -> Type[Entity]:
        """applicable_type 字符串对应的 Pydantic 类"""
        return ENTITY_TYPES[cls.applicable_type]

    # ---- 用户重写的钩子 ----

    def scan(self, entity: Entity) -> Any:
        """
        采集阶段：拿数据。
        默认实现：什么都不做，直接把 entity 当 raw 返回。
        子类要实现 IO (HTTP / DNS / DB 查询) 时，重写此方法；可以是 async。
        """
        return entity

    @abstractmethod
    def postprocess(self, raw: Any, entity: Entity) -> EnrichmentResult:
        """处理阶段：把 raw + entity 转成 EnrichmentResult。必须实现。"""
        ...

    # ---- Pipeline 调用的入口 ----

    def enrich(self, entity: Entity) -> EnrichmentResult:
        """
        同步入口。Pipeline 调这个。
        - sync scan → postprocess
        - async scan → postprocess（run 出来再喂 postprocess）
        """
        t0 = time.time()
        cls = type(self)
        cls.last_stats["scanned"] += 1
        try:
            raw = self._maybe_await_scan(entity)
            result = self.postprocess(raw, entity)
        except Exception as e:
            logger.exception("[%s] failed on %s", self.name, getattr(entity, "id", "?"))
            result = EnrichmentResult(errors=[f"{type(e).__name__}: {e}"])
            cls.last_stats["errors"] += 1

        cls.last_stats["succeeded"] += int(not result.errors)
        cls.last_stats["duration_ms"] += int((time.time() - t0) * 1000)
        return result

    def _maybe_await_scan(self, entity):
        """scan() 是 sync 直接调；是 async coroutine 就 run 出来"""
        scan_result = self.scan(entity)
        if asyncio.iscoroutine(scan_result):
            # 单条 entity 不需要真异步；用 run 一圈
            try:
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    return scan_result  # 让 pipeline 决定要不要 await
            except RuntimeError:
                pass
            return asyncio.run(scan_result)
        return scan_result


# ---- 帮助函数 ----

def entity_id(entity: Entity) -> str:
    """通用拿 id"""
    return getattr(entity, "id", str(entity))


def safe_result(properties: dict | None = None,
                relationships: list | None = None,
                new_entities: list | None = None) -> EnrichmentResult:
    """构造 EnrichmentResult 的糖"""
    return EnrichmentResult(
        properties=properties or {},
        relationships=relationships or [],
        new_entities=new_entities or [],
    )
