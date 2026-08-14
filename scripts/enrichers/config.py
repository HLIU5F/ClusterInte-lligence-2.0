"""
Enricher 配置加载器

设计：
- 不存在 config / 没启用 → 用内置默认（全开）
- 显式 disable：enrichers.<name>.enabled = false
- 给某个 enricher 传参：enrichers.<name>.params.timeout_sec = 5

结构：
    enrichers:
      ip_geo:
        enabled: true
        params:
          cache_size: 1024
          timeout_sec: 5
      port_service:
        enabled: false

yaml 不存在 → 不抛错，安静走内置默认（避免第一次跑就被炸）。
"""
from __future__ import annotations
from pathlib import Path
from typing import Dict, Any, List, Tuple, Optional

from .registry import REGISTRY


DEFAULT_CONFIG: Dict[str, Any] = {
    "enrichers": "all",  # "all" 或显式列表 ['ip_geo', 'port_service']
    "fail_fast": False,  # 一个 enricher 整体炸了是否停
    "concurrency": 4,    # 给后续真异步预留
}


class Config:
    def __init__(self, raw: Optional[Dict[str, Any]] = None):
        self.raw: Dict[str, Any] = {**DEFAULT_CONFIG, **(raw or {})}

    @classmethod
    def from_yaml(cls, path: Optional[str | Path]) -> "Config":
        if path is None:
            return cls(DEFAULT_CONFIG)
        p = Path(path)
        if not p.exists():
            return cls(DEFAULT_CONFIG)
        try:
            import yaml  # type: ignore
        except ImportError:
            # 没装 pyyaml 就走默认
            return cls(DEFAULT_CONFIG)
        with open(p, "r", encoding="utf-8") as f:
            return cls(yaml.safe_load(f) or {})

    # ---- 实际启用哪些 ----

    def enabled_enrichers(self) -> List[Tuple[str, Dict[str, Any]]]:
        """
        返回 [(name, params_dict)] 列表。
        规则：
        1. raw['enrichers'] == 'all'（默认）→ 注册表里 enabled=True 的全开
        2. raw['enrichers'] 是列表 → 用列表（每个元素是 name 或 {name: params}）
        3. raw['enrichers'] 是 dict → 用 dict，但要求 .enabled != false
        """
        declared = self.raw.get("enrichers", "all")
        if declared == "all" or not declared:
            return [(cls.name, {})
                    for cls in REGISTRY.values()
                    if getattr(cls, "enabled", True)]

        # 列表形式
        if isinstance(declared, list):
            out = []
            for entry in declared:
                if isinstance(entry, str):
                    out.append((entry, {}))
                elif isinstance(entry, dict):
                    for name, params in entry.items():
                        out.append((name, params or {}))
                else:
                    raise ValueError(f"enrichers 配置项格式错: {entry!r}")
            return out

        # dict 形式
        if isinstance(declared, dict):
            out = []
            for name, sub in declared.items():
                sub = sub or {}
                if sub.get("enabled", True) is False:
                    continue
                params = sub.get("params", {}) or {}
                out.append((name, params))
            return out

        raise ValueError(f"无法解析 enrichers 配置: {declared!r}")

    def get(self, key: str, default=None):
        return self.raw.get(key, default)
