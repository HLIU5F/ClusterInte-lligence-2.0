"""
subnet_cidr enricher（适用于 SubnetEntity）
判定子网类型：
- RFC1918（10/8, 172.16/12, 192.168/16）
- Loopback (127/8)
- CGNAT (100.64/10)
- Multicast (224/4)
- Link-local (169.254/16)
- 类地址 ABC
"""
from __future__ import annotations
import ipaddress

from .base import BaseEnricher, safe_result
from .registry import enricher
from .types import SubnetEntity, EnrichmentResult


@enricher
class SubnetCIDREnricher(BaseEnricher):
    name = "subnet_cidr"
    category = "Network"
    description = "子网类型识别（RFC1918 / loopback / multicast / link-local）+ ABC 类"
    applicable_type = "Subnet"

    def postprocess(self, raw, entity: SubnetEntity) -> EnrichmentResult:
        try:
            net = ipaddress.ip_network(entity.cidr, strict=False)
        except ValueError:
            return EnrichmentResult(errors=[f"invalid cidr: {entity.cidr}"])

        a, b, c = 0, 0, 0
        first = int(net.network_address) >> 24
        if net.prefixlen == 8:
            a, b, c = first, 0, 0
        elif net.prefixlen == 16:
            a = first
            # 拿 network 的第 2 个字节
            second = (int(net.network_address) >> 16) & 0xFF
            b = second
        elif net.prefixlen == 24:
            a = first
            second = (int(net.network_address) >> 16) & 0xFF
            third = int(net.network_address) & 0xFF
            b, c = second, third

        return safe_result(properties={
            "class_a": a,
            "class_b": b,
            "class_c": c,
            "is_private": bool(
                net.is_private
                or net.is_loopback
                or net.is_link_local
                or net.is_multicast
            ),
            "ip_count": int(net.num_addresses),
        })
