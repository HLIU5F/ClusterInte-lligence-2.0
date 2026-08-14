"""
IP 地理位置 enricher

策略：
- 内网 IP（10/8, 172.16/12, 192.168/16, 127/8）→ 不调用外网，直接 RFC1918
- 公网 IP → 试 ip-api.com（免费，无需 key，限 45 req/min）
  - 带本地 LRU 缓存
  - 离线模式（offline=true）→ 跳过 API 用 stub
- 失败 → EnrichmentResult.errors += 1，不阻断
"""
from __future__ import annotations
import ipaddress
import logging
from functools import lru_cache
from typing import Optional, Dict, Any

from .base import BaseEnricher, safe_result
from .registry import enricher
from .types import IPEntity, EnrichmentResult

logger = logging.getLogger(__name__)


@enricher
class IPGeoEnricher(BaseEnricher):
    name = "ip_geo"
    category = "Geo"
    description = "IP 地理位置（优先内网 RFC1918 识别，公网 IP 走 ip-api.com）"
    applicable_type = "IP"

    # ---- 改自这些参数从 pipeline kwargs 透传（通过继承设默认） ----
    offline: bool = True           # 用户内网 demo 默认 True；以后真公网数据就 False
    cache_size: int = 4096
    timeout_sec: float = 3.0

    # ---- 内网快判 ----

    @staticmethod
    def _is_private(ip: str) -> Optional[Dict[str, str]]:
        try:
            addr = ipaddress.IPv4Address(ip)
        except ValueError:
            return None
        if addr.is_loopback:
            return {"country": "LOOPBACK", "city": "Loopback", "isp": "Localhost", "org": "RFC1122"}
        if addr.is_private:
            # 区分 RFC1918 三段
            if addr in ipaddress.ip_network("10.0.0.0/8"):
                return {"country": "CN", "city": "内网", "isp": "Private Network", "org": "RFC1918-10/8"}
            if addr in ipaddress.ip_network("172.16.0.0/12"):
                return {"country": "CN", "city": "内网", "isp": "Private Network", "org": "RFC1918-172.16/12"}
            if addr in ipaddress.ip_network("192.168.0.0/16"):
                return {"country": "CN", "city": "内网", "isp": "Private Network", "org": "RFC1918-192.168/16"}
            # CGNAT 100.64/10
            return {"country": "CN", "city": "内网", "isp": "Carrier-Grade NAT", "org": "RFC6598"}
        if addr.is_multicast:
            return {"country": "MULTICAST", "city": "Multicast", "isp": "RFC5771", "org": "RFC5771"}
        if addr.is_reserved:
            return {"country": "RESERVED", "city": "Reserved", "isp": "RFC1112", "org": "RFC1112"}
        return None

    # ---- 缓存 ----

    def __init__(self):
        # 自己一个 LRU
        self._cache: Dict[str, Optional[Dict[str, str]]] = {}

    def _cached(self, ip: str) -> Optional[Dict[str, str]]:
        if ip in self._cache:
            return self._cache[ip]
        if len(self._cache) > self.cache_size:
            self._cache.clear()
        return None

    # ---- scan: 数据采集 ----

    def scan(self, entity: IPEntity) -> Optional[Dict[str, str]]:
        ip = entity.ip
        # private 网 → 直接返回，不打外网
        priv = self._is_private(ip)
        if priv is not None:
            return priv
        if self.offline:
            return {"country": "OFFLINE", "city": "—", "isp": "—", "org": "stub"}

        # 缓存命中
        hit = self._cached(ip)
        if hit is not None:
            return hit

        # 打 ip-api
        try:
            import requests  # type: ignore
            resp = requests.get(
                f"http://ip-api.com/json/{ip}",
                timeout=self.timeout_sec,
                params={"fields": "status,country,city,isp,org"},
            )
            data = resp.json()
            if data.get("status") == "success":
                out = {
                    "country": data.get("country") or "Unknown",
                    "city": data.get("city") or "Unknown",
                    "isp": data.get("isp") or "Unknown",
                    "org": data.get("org") or "Unknown",
                }
            else:
                out = {"country": "Unknown", "city": "Unknown", "isp": "Unknown", "org": "Unknown"}
        except Exception as e:
            logger.warning("ip-api.com 失败 %s: %s", ip, e)
            out = {"country": "Unknown", "city": "Unknown", "isp": "Unknown", "org": "Unknown"}

        self._cache[ip] = out
        return out

    # ---- postprocess: 落数据 ----

    def postprocess(self, raw: Optional[Dict[str, str]], entity: IPEntity) -> EnrichmentResult:
        if raw is None:
            # IP 格式就不合法
            return EnrichmentResult(
                properties={"geo_country": "INVALID"},
                errors=[f"invalid ip: {entity.ip}"],
            )

        return safe_result(properties={
            "geo_country": raw["country"],
            "geo_city": raw.get("city"),
            "geo_isp": raw.get("isp"),
            "geo_org": raw.get("org"),
        })
