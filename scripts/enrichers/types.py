"""
Pydantic 实体模型 (flowsint 风格)
每个实体 = 一个 graph 节点类型 + 一个 Pydantic BaseModel + 一个 primary field。

继承约定：
- primary=True  → 在 UI / topology 里显示的字段
- 关系创建 → Enricher 输出的 relationships[], 不是模型本身的方法
- 节点 id 用 .id, 避免和 Pydantic v2 的 model_id 撞车
"""
from __future__ import annotations
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field, ConfigDict


class Entity(BaseModel):
    """所有 enricher 实体的根"""
    model_config = ConfigDict(extra="ignore", validate_assignment=True)

    # node id; 在 Neo4j 是 :Label.id
    id: str = Field(..., description="该节点在图中的唯一 id")


class IPEntity(Entity):
    """一个 IPv4 节点"""
    primary: str = Field(default="ip", description="primary key label")

    ip: str = Field(..., description="如 10.100.1.20")
    subnet_24: Optional[str] = Field(None, description="/24 网段 cidr")
    degree: int = 0
    in_degree: int = 0
    out_degree: int = 0
    ports: List[int] = Field(default_factory=list, description="此 IP 开放/监听的端口")
    community: int = -1
    anomaly_score: float = 0.0
    is_hub: bool = False
    protocols: List[str] = Field(default_factory=list, description="tcp/udp/icmp 协议名单")

    # enricher 写入区（每加一个 enricher，可以往这里塞字段）
    geo_country: Optional[str] = None
    geo_city: Optional[str] = None
    geo_isp: Optional[str] = None
    geo_org: Optional[str] = None
    is_private: bool = False
    service_type: Optional[str] = None
    service_confidence: float = 0.0
    anomaly_score_enriched: Optional[float] = None
    role_guess: Optional[str] = None
    anomaly_level: Optional[str] = None
    zone_id: Optional[str] = None
    zone_label: Optional[str] = None
    is_core_infra: bool = False
    domain_source: Optional[str] = None
    business_degree: float = 0.0

    # 调试用：经历过哪些 enricher
    enricher_chain: List[str] = Field(default_factory=list)


class SubnetEntity(Entity):
    primary: str = Field(default="cidr")

    cidr: str = Field(..., description="如 10.100.1.0/24")
    ip_count: int = 0
    class_a: int = 0           # 10 / 172 / 192
    class_b: int = 0           # 100 / 16 / 168
    class_c: int = 0
    is_private: bool = False   # RFC1918 / loopback / multicast


class ZoneEntity(Entity):
    primary: str = Field(default="zone_id")

    zone_id: str = Field(..., description="字符串化的 community id")
    label: str
    color: Optional[str] = None
    ip_count: int = 0


class DomainEntity(Entity):
    primary: str = Field(default="domain")

    domain: str = Field(..., description="如 example.com")
    tld: Optional[str] = None
    registrar: Optional[str] = None


class ServiceEntity(Entity):
    primary: str = Field(default="name_port")

    name: str = Field(..., description="如 MySQL / HTTPS")
    port: int
    protocol: str = Field(default="tcp", description="tcp / udp")
    category: Optional[str] = None  # 类别: Web / DB / Cache / RemoteAccess ...


class EnrichmentResult(BaseModel):
    """单个 enricher 作用于单个 entity 的产出（按 flowsint 的 {properties, relationships, new_entities}）"""
    properties: Dict[str, Any] = Field(default_factory=dict, description="写到 entity 上的字段")
    relationships: List[Dict[str, Any]] = Field(
        default_factory=list,
        description="要创建的关系 [{type, target, target_type, props?}]"
    )
    new_entities: List[Entity] = Field(
        default_factory=list,
        description="发现的新实体（递归 enrichment 的入口）"
    )
    errors: List[str] = Field(default_factory=list)


# 全部内置 label → 模型 的映射，给注册器和 pipeline 用
ENTITY_TYPES = {
    "IP": IPEntity,
    "Subnet": SubnetEntity,
    "Zone": ZoneEntity,
    "Domain": DomainEntity,
    "Service": ServiceEntity,
}
