"""
Enricher 系统单元测试

跑法（在项目根目录）:
    PYTHONPATH=scripts python -m pytest tests/test_enrichers.py -v

或用 workbuddy venv:
    PYTHONPATH=scripts "C:\\...\\python.exe" -m pytest tests/test_enrichers.py -v
"""
import sys
from pathlib import Path

# 确保能 import scripts.enrichers
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

import pytest
from enrichers import (
    BaseEnricher, Config, Pipeline, REGISTRY,
    IPEntity, SubnetEntity, ServiceEntity,
    list_enrichers, get, reset_for_tests,
)
from enrichers.ip_geo import IPGeoEnricher
from enrichers.service_type import ServiceTypeEnricher
from enrichers.port_service import PortServiceEnricher
from enrichers.subnet_cidr import SubnetCIDREnricher
from enrichers.anomaly_score import AnomalyScoreEnricher, normalize_anomaly_scores


# ---------- Registry ----------

class TestRegistry:
    def test_all_enrichers_registered(self):
        names = {c.name for c in list_enrichers(enabled_only=False)}
        assert names == {"ip_geo", "service_type", "port_service", "subnet_cidr", "anomaly_score"}

    def test_get_by_name(self):
        assert get("ip_geo") is IPGeoEnricher
        assert get("nonexistent") is None

    def test_category_filter(self):
        service_enrichers = list_enrichers(category="Service")
        assert len(service_enrichers) == 2  # service_type + port_service


# ---------- IPGeoEnricher ----------

class TestIPGeo:
    def test_private_10(self):
        ent = IPEntity(id="10.100.1.5", ip="10.100.1.5")
        r = IPGeoEnricher().enrich(ent)
        assert r.properties["geo_country"] == "CN"
        assert r.properties["geo_city"] == "内网"
        assert "RFC1918" in r.properties["geo_org"]

    def test_private_192(self):
        ent = IPEntity(id="192.168.1.1", ip="192.168.1.1")
        r = IPGeoEnricher().enrich(ent)
        assert "RFC1918" in r.properties["geo_org"]

    def test_loopback(self):
        ent = IPEntity(id="127.0.0.1", ip="127.0.0.1")
        r = IPGeoEnricher().enrich(ent)
        assert r.properties["geo_country"] == "LOOPBACK"

    def test_offline_public(self):
        ent = IPEntity(id="8.8.8.8", ip="8.8.8.8")
        e = IPGeoEnricher()
        e.offline = True
        r = e.enrich(ent)
        assert r.properties["geo_country"] == "OFFLINE"


# ---------- ServiceTypeEnricher ----------

class TestServiceType:
    def test_web(self):
        ent = IPEntity(id="10.1.1.1", ip="10.1.1.1", ports=[80, 443])
        r = ServiceTypeEnricher().enrich(ent)
        assert r.properties["service_type"] == "Web"
        assert r.properties["service_confidence"] > 0

    def test_db(self):
        ent = IPEntity(id="10.1.1.2", ip="10.1.1.2", ports=[3306, 5432])
        r = ServiceTypeEnricher().enrich(ent)
        assert r.properties["service_type"] == "Database"

    def test_empty_ports(self):
        ent = IPEntity(id="10.1.1.3", ip="10.1.1.3", ports=[])
        r = ServiceTypeEnricher().enrich(ent)
        assert r.properties["service_type"] == "未知"


# ---------- PortServiceEnricher ----------

class TestPortService:
    def test_known_port(self):
        ent = IPEntity(id="10.1.1.1", ip="10.1.1.1", ports=[80, 3306])
        r = PortServiceEnricher().enrich(ent)
        assert len(r.new_entities) == 2
        assert r.new_entities[0].name == "HTTP"
        assert r.new_entities[1].name == "MySQL"
        assert len(r.relationships) == 2
        assert all(rel["type"] == "RUNS" for rel in r.relationships)

    def test_unknown_port(self):
        ent = IPEntity(id="10.1.1.1", ip="10.1.1.1", ports=[9999])
        e = PortServiceEnricher()
        e.include_unknown = True
        r = e.enrich(ent)
        assert len(r.new_entities) == 1
        assert r.new_entities[0].name == "Port-9999"

    def test_collector_ports(self):
        ent = IPEntity(id="10.26.0.26", ip="10.26.0.26", ports=[36000, 18060, 22003])
        r = PortServiceEnricher().enrich(ent)
        names = {svc.name for svc in r.new_entities}
        assert names == {"UPShield-Collector", "ISA-Collector", "ISA-Service"}
        assert all(svc.category in {"Logging", "Monitoring", "Infra"} for svc in r.new_entities)

    def test_skip_unknown(self):
        ent = IPEntity(id="10.1.1.1", ip="10.1.1.1", ports=[9999])
        e = PortServiceEnricher()
        e.include_unknown = False
        r = e.enrich(ent)
        assert len(r.new_entities) == 0


# ---------- SubnetCIDREnricher ----------

class TestSubnetCIDR:
    def test_rfc1918_10(self):
        ent = SubnetEntity(id="10.100.1.0/24", cidr="10.100.1.0/24")
        r = SubnetCIDREnricher().enrich(ent)
        assert r.properties["is_private"] is True
        assert r.properties["class_a"] == 10

    def test_loopback(self):
        ent = SubnetEntity(id="127.0.0.0/8", cidr="127.0.0.0/8")
        r = SubnetCIDREnricher().enrich(ent)
        assert r.properties["is_private"] is True

    def test_public(self):
        ent = SubnetEntity(id="8.8.8.0/24", cidr="8.8.8.0/24")
        r = SubnetCIDREnricher().enrich(ent)
        assert r.properties["is_private"] is False


# ---------- AnomalyScoreEnricher ----------

class TestAnomalyScore:
    def test_basic_score(self):
        ent = IPEntity(id="10.1.1.1", ip="10.1.1.1", degree=5, ports=[80, 443], is_hub=True)
        r = AnomalyScoreEnricher().enrich(ent)
        assert "anomaly_score_enriched" in r.properties
        # degree(5) + 5*is_hub(5) + 2*ports(4) = 14
        assert r.properties["anomaly_score_enriched"] == 14.0

    def test_normalize(self):
        ips = [
            IPEntity(id="a", ip="a", degree=1, ports=[], anomaly_score_enriched=1.0),
            IPEntity(id="b", ip="b", degree=10, ports=[], anomaly_score_enriched=10.0),
        ]
        normalize_anomaly_scores(ips)
        assert ips[0].anomaly_score_enriched == 0.0
        assert ips[1].anomaly_score_enriched == 1.0


# ---------- Pipeline ----------

class TestPipeline:
    def test_run_on_sample(self):
        nodes = [
            {"id": "10.100.1.1", "ip": "10.100.1.1", "degree": 3, "ports": [80, 443], "community": 0},
            {"id": "10.100.1.2", "ip": "10.100.1.2", "degree": 1, "ports": [3306], "community": 0},
        ]
        links = [{"source": "10.100.1.1", "target": "10.100.1.2", "weight": 1}]

        pl = Pipeline(Config.from_yaml(None))
        res = pl.run(nodes, links)

        assert len(res.ips) == 2
        assert len(res.services) == 3  # HTTP, HTTPS, MySQL
        assert len(res.new_relationships) == 3  # 3 RUNS
        # IP geo 应该被填充
        assert res.ips[0].geo_country == "CN"
        # service_type 应该被推断
        assert res.ips[0].service_type == "Web"
        assert res.ips[1].service_type == "Database"
        # anomaly_score 应该被归一化到 [0, 1]
        for ip in res.ips:
            assert 0.0 <= ip.anomaly_score_enriched <= 1.0

    def test_enricher_stats(self):
        nodes = [{"id": "10.1.1.1", "ip": "10.1.1.1", "ports": [80]}]
        pl = Pipeline(Config.from_yaml(None))
        res = pl.run(nodes, [])
        for name, stats in res.enricher_stats.items():
            if name == "subnet_cidr":
                continue  # Subnet enricher 不跑（没 Subnet 节点）
            assert stats["scanned"] >= 1


# ---------- Config ----------

class TestConfig:
    def test_default_all(self):
        cfg = Config.from_yaml(None)
        enabled = cfg.enabled_enrichers()
        names = [n for n, _ in enabled]
        assert "ip_geo" in names
        assert "anomaly_score" in names

    def test_nonexistent_yaml(self):
        cfg = Config.from_yaml("nonexistent.yaml")
        assert cfg.raw["enrichers"] == "all"
