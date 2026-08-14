"""
Enricher 注册器（flowsint 风格 @enricher 装饰器）

用法：

    from scripts.enrichers.registry import enricher, REGISTRY, get, list_enrichers

    @enricher
    class MyEnricher(BaseEnricher):
        name = "my_enricher"
        category = "Geo"
        applicable_type = "IP"
        ...

    # Pipeline 里
    for cls in list_enrichers():
        result = cls().enrich(entity)
"""
from __future__ import annotations
from typing import Dict, List, Type, Iterable, Optional

from .base import BaseEnricher


# 全局唯一注册表 {name -> class}
REGISTRY: Dict[str, Type[BaseEnricher]] = {}

# 重复注册检测
_WARNED_DUP: set[str] = set()


def enricher(cls: Type[BaseEnricher]) -> Type[BaseEnricher]:
    """
    装饰器：把 enricher class 注册到 REGISTRY

    key 取 cls.name，若空则用类名小写。
    重复注册默认 warn，不覆盖（防止 import 顺序导致丢失）。
    """
    if not issubclass(cls, BaseEnricher):
        raise TypeError(f"@enricher 只装饰 BaseEnricher 子类；{cls} 不合格")

    key = (cls.name or cls.__name__.lower()).strip()
    if not key:
        raise ValueError(f"{cls.__name__} 必须设 name 类属性")

    if key in REGISTRY and key not in _WARNED_DUP:
        existing = REGISTRY[key]
        if existing is not cls:
            # 让 import 的覆盖警告一次（避免循环 import 时一直刷屏）
            import warnings
            warnings.warn(
                f"Enricher name '{key}' 被重复注册；"
                f"先前={existing.__module__}.{existing.__name__}, "
                f"现在={cls.__module__}.{cls.__name__}. 保留先注册的，忽略新的。",
                RuntimeWarning,
                stacklevel=2,
            )
            _WARNED_DUP.add(key)
        # 已注册 + 不覆盖
        return REGISTRY[key]

    REGISTRY[key] = cls
    cls.registered_key = key  # type: ignore[attr-defined]
    return cls


def get(name: str) -> Optional[Type[BaseEnricher]]:
    """按 name 查 class；找不到返回 None"""
    return REGISTRY.get(name)


def list_enrichers(
    *,
    category: Optional[str] = None,
    enabled_only: bool = True,
) -> List[Type[BaseEnricher]]:
    """
    列出 enricher class 列表。
    默认只返回 enabled=True 的（除非显式 enabled_only=False）。
    """
    out: List[Type[BaseEnricher]] = []
    for cls in REGISTRY.values():
        if enabled_only and not getattr(cls, "enabled", True):
            continue
        if category and cls.category != category:
            continue
        out.append(cls)
    # 按 category 字母序，再按 name 字母序，输出稳定
    out.sort(key=lambda c: (c.category, c.name))
    return out


def iter_instances(
    *,
    category: Optional[str] = None,
    enabled_only: bool = True,
) -> Iterable[BaseEnricher]:
    """已经实例化的生成器，pipeline 直接 for-loop 就能用"""
    for cls in list_enrichers(category=category, enabled_only=enabled_only):
        yield cls()


def reset_for_tests() -> None:
    """测试用：清空注册表"""
    REGISTRY.clear()
    _WARNED_DUP.clear()
