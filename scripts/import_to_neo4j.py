# -*- coding: utf-8 -*-
"""
Cluster-Intelligence v2 importer

Features:
- Multi-label nodes: IP / Subnet / Zone / Service / GDSZone
- Relationships: BELONGS_TO / IN_ZONE / CONNECTS_TO / RUNS / IN_GDS_ZONE
- Bulk UNWIND for fast writes
- Subnet assignment to Zone via majority vote (avoids fanout duplicate MERGE)
- P2 v2: runs the Enricher Pipeline first, then persists to Neo4j
  (no longer relies on stale JSON fields)
- Supports topology_data_business.json (flow_class / is_core_infra /
  domain_source) and preserves role_guess / zone_id / anomaly_level etc.
- CMDB-ready: business_group / os / application / owner / environment /
  cmdb_tags are persisted as IP properties and materialized as
  BusinessGroup / OS / Application / Environment nodes with ownership edges.
"""
import json
import sys
import argparse
from collections import Counter
from pathlib import Path
from neo4j import GraphDatabase

# Ensure the enrichers package is importable when this script is invoked directly.
sys.path.insert(0, str(Path(__file__).parent))

from enrichers import Pipeline, Config

URI = "bolt://127.0.0.1:7687"
USER = "neo4j"
PASSWORD = "neo4j123456"
JSON_PATH = "scripts/topology_data_enriched.json"
CONFIG_PATH = "config/enrichers.yaml"

DOMAIN_LABELS = {
    "core_infra": "核心基础设施域",
    "isolated": "孤立节点域",
}

# 12-color palette (kept consistent with the frontend D3 renderer).
ZONE_COLORS = ["#00d4ff", "#ff6b35", "#a855f7", "#10b981", "#f59e0b", "#ec4899",
               "#22d3ee", "#84cc16", "#f43f5e", "#8b5cf6", "#fb923c", "#06b6d4"]


class ClusterImporter:
    def __init__(self, uri=URI, user=USER, password=PASSWORD, run_pipeline=True,
                 config_path=CONFIG_PATH, dry_run=False, clear=True):
        self.uri = uri
        self.user = user
        self.password = password
        self.driver = None if dry_run else GraphDatabase.driver(uri, auth=(user, password))
        self.run_pipeline = run_pipeline
        self.config_path = config_path
        self.dry_run = dry_run
        self.clear_db = clear
        self.pipeline_result = None
        self._domain_names: dict = {}

    def close(self):
        if self.driver is not None:
            self.driver.close()

    @staticmethod
    def subnet_of(ip: str) -> str:
        parts = ip.split(".")
        return f"{parts[0]}.{parts[1]}.{parts[2]}.0/24" if len(parts) == 4 else "0.0.0.0/0"

    def init_schema(self, s):
        s.run("CREATE CONSTRAINT ip_id_unique IF NOT EXISTS FOR (n:IP) REQUIRE n.id IS UNIQUE")
        s.run("CREATE CONSTRAINT subnet_cidr_unique IF NOT EXISTS FOR (n:Subnet) REQUIRE n.cidr IS UNIQUE")
        s.run("CREATE CONSTRAINT zone_id_unique IF NOT EXISTS FOR (n:Zone) REQUIRE n.id IS UNIQUE")
        s.run("CREATE CONSTRAINT service_id_unique IF NOT EXISTS FOR (n:Service) REQUIRE n.id IS UNIQUE")
        s.run("CREATE CONSTRAINT business_group_name_unique IF NOT EXISTS FOR (n:BusinessGroup) REQUIRE n.name IS UNIQUE")
        s.run("CREATE CONSTRAINT os_name_unique IF NOT EXISTS FOR (n:OS) REQUIRE n.name IS UNIQUE")
        s.run("CREATE CONSTRAINT application_name_unique IF NOT EXISTS FOR (n:Application) REQUIRE n.name IS UNIQUE")
        s.run("CREATE CONSTRAINT environment_name_unique IF NOT EXISTS FOR (n:Environment) REQUIRE n.name IS UNIQUE")
        s.run("CREATE INDEX ip_subnet IF NOT EXISTS FOR (n:IP) ON (n.subnet_24)")
        s.run("CREATE INDEX ip_community IF NOT EXISTS FOR (n:IP) ON (n.community)")
        s.run("CREATE INDEX service_port IF NOT EXISTS FOR (n:Service) ON (n.port)")

    def clear(self, s):
        s.run("MATCH (n) DETACH DELETE n")

    @staticmethod
    def _majority_zone(subnet_to_comms: dict) -> dict:
        out = {}
        for cidr, comms in subnet_to_comms.items():
            counter = Counter(comms)
            max_freq = max(counter.values())
            winners = sorted(c for c, n in counter.items() if n == max_freq)
            out[cidr] = winners[0]
        return out

    def import_ips(self, s, ips, cmdb_by_id=None):
        """ips: List[IPEntity] from pipeline result; cmdb_by_id keeps raw JSON CMDB fields."""
        cmdb_by_id = cmdb_by_id or {}
        ip_rows = []
        subnet_to_comms = {}

        for ip in ips:
            subnet = self.subnet_of(ip.ip)
            raw = cmdb_by_id.get(ip.id, {})
            ip_rows.append({
                'id': ip.id,
                'ip': ip.ip,
                'subnet_24': subnet,
                'community': ip.community,
                'degree': ip.degree,
                'in_degree': ip.in_degree,
                'out_degree': ip.out_degree,
                'anomaly_score': ip.anomaly_score,
                'anomaly_score_enriched': ip.anomaly_score_enriched,
                'is_hub': ip.is_hub,
                'service_type': ip.service_type,
                'service_confidence': ip.service_confidence,
                'role_guess': ip.role_guess,
                'anomaly_level': ip.anomaly_level,
                'zone_id': ip.zone_id,
                'zone_label': ip.zone_label,
                'is_core_infra': bool(ip.is_core_infra),
                'domain_source': ip.domain_source,
                'business_degree': float(ip.business_degree or 0),
                'ports': [int(p) for p in (ip.ports or [])],
                'protocols': [str(p) for p in (ip.protocols or [])],
                'geo_country': ip.geo_country,
                'geo_city': ip.geo_city,
                'geo_isp': ip.geo_isp,
                'geo_org': ip.geo_org,
                'enricher_chain': ip.enricher_chain,
                'business_group': raw.get('business_group'),
                'os_name': raw.get('os_name') or raw.get('os'),
                'application': raw.get('application') or raw.get('app'),
                'owner': raw.get('owner'),
                'environment': raw.get('environment') or raw.get('env'),
                'cmdb_tags': list(raw.get('cmdb_tags') or raw.get('tags') or []),
            })
            subnet_to_comms.setdefault(subnet, []).append(ip.community)

        if s is not None:
            s.run("""
            UNWIND $rows AS r
            MERGE (ip:IP {id: r.id})
            SET ip.ip                    = r.ip,
                ip.subnet_24             = r.subnet_24,
                ip.community             = r.community,
                ip.degree                = r.degree,
                ip.in_degree             = r.in_degree,
                ip.out_degree            = r.out_degree,
                ip.anomaly_score         = r.anomaly_score,
                ip.anomaly_score_enriched = r.anomaly_score_enriched,
                ip.is_hub                = r.is_hub,
                ip.service_type          = r.service_type,
                ip.service_confidence    = r.service_confidence,
                ip.role_guess            = r.role_guess,
                ip.anomaly_level         = r.anomaly_level,
                ip.zone_id               = r.zone_id,
                ip.zone_label            = r.zone_label,
                ip.is_core_infra         = r.is_core_infra,
                ip.domain_source         = r.domain_source,
                ip.business_degree       = r.business_degree,
                ip.ports                 = r.ports,
                ip.protocols             = r.protocols,
                ip.geo_country           = r.geo_country,
                ip.geo_city              = r.geo_city,
                ip.geo_isp               = r.geo_isp,
                ip.geo_org               = r.geo_org,
                ip.enricher_chain        = r.enricher_chain,
                ip.business_group        = r.business_group,
                ip.os_name               = r.os_name,
                ip.application           = r.application,
                ip.owner                 = r.owner,
                ip.environment           = r.environment,
                ip.cmdb_tags             = r.cmdb_tags

            MERGE (sn:Subnet {cidr: r.subnet_24})
            MERGE (ip)-[:BELONGS_TO]->(sn)
            """, rows=ip_rows)

        subnet_zone = {}
        if subnet_to_comms:
            subnet_zone = self._majority_zone(subnet_to_comms)
            zone_rows = [{'id': str(z), 'cidr': cidr, 'color': ZONE_COLORS[z % 12],
                          'label': self._domain_names.get(str(z), f'Zone {z}')}
                         for cidr, z in subnet_zone.items()]
            if s is not None:
                s.run("""
                UNWIND $rows AS r
                MERGE (z:Zone {id: r.id})
                ON CREATE SET z.color = r.color,
                              z.label = r.label
                WITH r, z
                MATCH (sn:Subnet {cidr: r.cidr})
                MERGE (sn)-[:IN_ZONE]->(z)
                """, rows=zone_rows)
            else:
                print(f"  Zones planned: {len(set(subnet_zone.values()))}")

        print(f"  IPs: {len(ip_rows)}  Subnets: {len(subnet_zone)}  Zones: {len(set(subnet_zone.values()))}")

    def import_cmdb_dimensions(self, s, ips, cmdb_by_id=None):
        """Materialize CMDB dimensions as nodes instead of only IP properties."""
        cmdb_by_id = cmdb_by_id or {}
        specs = [
            ("BusinessGroup", "BELONGS_TO_GROUP", "business_group"),
            ("OS", "RUNS_ON", "os_name"),
            ("Application", "RUNS_APP", "application"),
            ("Environment", "IN_ENVIRONMENT", "environment"),
        ]
        total_rels = 0
        for label, rel, field in specs:
            rows = []
            for ip in ips:
                raw = cmdb_by_id.get(ip.id, {})
                value = raw.get(field)
                if not value:
                    continue
                rows.append({"ip": ip.id, "name": str(value)})
            if s is not None and rows:
                s.run(f"""
                UNWIND $rows AS r
                MATCH (ip:IP {{id: r.ip}})
                MERGE (n:{label} {{name: r.name}})
                MERGE (ip)-[:{rel}]->(n)
                """, rows=rows)
            total_rels += len(rows)
            if rows:
                print(f"  CMDB {label}: {len(rows)}")
        if total_rels == 0:
            print("  CMDB dimensions: (none)")

    def import_domain_zones(self, s, ips):
        """business model: create one Zone per domain_source and link IPs to it."""
        groups = {}
        for ip in ips:
            source = getattr(ip, 'domain_source', None)
            if not source:
                continue
            groups.setdefault(source, []).append(ip)
        if not groups:
            print("  Domains: (none)")
            return

        zone_rows = []
        ip_rows = []
        for idx, (source, members) in enumerate(sorted(groups.items())):
            zid = f"domain_{source}"
            zone_rows.append({
                'id': zid,
                'label': DOMAIN_LABELS.get(source, f"业务域 {source}"),
                'color': ZONE_COLORS[idx % len(ZONE_COLORS)],
            })
            for ip in members:
                ip_rows.append({'ip_id': ip.id, 'zone_id': zid})

        if s is not None:
            s.run("""
            UNWIND $rows AS r
            MERGE (z:Zone {id: r.id})
            ON CREATE SET z.label = r.label, z.color = r.color
            """, rows=zone_rows)
            s.run("""
            UNWIND $rows AS r
            MATCH (ip:IP {id: r.ip_id}), (z:Zone {id: r.zone_id})
            MERGE (ip)-[:IN_ZONE]->(z)
            """, rows=ip_rows)
        print(f"  Domains: {len(zone_rows)} zones / {len(ip_rows)} memberships")

    def import_services(self, s, services):
        """services: List[ServiceEntity] from pipeline result"""
        if not services:
            print("  Services: (none)")
            return
        rows = [{
            'id': svc.id,
            'name': svc.name,
            'port': svc.port,
            'protocol': svc.protocol,
            'category': svc.category,
        } for svc in services]

        if s is not None:
            s.run("""
            UNWIND $rows AS r
            MERGE (svc:Service {id: r.id})
            SET svc.name     = r.name,
                svc.port     = r.port,
                svc.protocol = r.protocol,
                svc.category = r.category
            """, rows=rows)
        print(f"  Services: {len(rows)}")

    def import_runs_rels(self, s, rels):
        """rels: List[dict] from pipeline_result.new_relationships where type=RUNS"""
        runs = [r for r in rels if r.get('type') == 'RUNS']
        if not runs:
            print("  RUNS: (none)")
            return
        rows = [{'src': r['source'], 'tgt': r['target']} for r in runs]

        if s is not None:
            s.run("""
            UNWIND $rows AS r
            MATCH (ip:IP {id: r.src}), (svc:Service {id: r.tgt})
            MERGE (ip)-[:RUNS]->(svc)
            """, rows=rows)
        print(f"  RUNS: {len(rows)}")

    def import_links(self, s, links):
        if not links:
            print("  links: (none)")
            return
        rows = []
        for l in links:
            src = l.get('source') or l.get('from')
            dst = l.get('target') or l.get('to')
            if not src or not dst:
                continue
            rows.append({
                'src': src, 'dst': dst,
                'weight': int(l.get('weight', 1) or 1),
                'bytes':  int(l.get('bytes', 0) or 0),
                'ports': sorted({int(p) for p in (l.get('ports') or [])}),
                'protocols': [str(p) for p in (l.get('protocols') or [])],
                'flow_class': l.get('flow_class'),
            })

        if s is not None:
            s.run("""
            UNWIND $rows AS r
            MATCH (a:IP {id: r.src}), (b:IP {id: r.dst})
            MERGE (a)-[rel:CONNECTS_TO {weight: r.weight, bytes: r.bytes}]->(b)
            SET rel.ports     = r.ports,
                rel.protocols = r.protocols,
                rel.flow_class = r.flow_class
            """, rows=rows)
        print(f"  CONNECTS_TO: {len(rows)}")

    def run(self, input_path=JSON_PATH):
        with open(input_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        nodes = data.get('nodes', [])
        links = data.get('links', [])
        cmdb_by_id = {n['id']: n for n in nodes if n.get('type', 'IP') == 'IP'}
        self._domain_names = data.get('domainNames', {})
        print(f"Domain names loaded: {len(self._domain_names)} entries")
        print(f"Loading {input_path}: {len(nodes)} nodes / {len(links)} links ...")

        has_business_fields = (
            any('is_core_infra' in n or 'domain_source' in n for n in nodes)
            or any('flow_class' in l for l in links)
        )
        if has_business_fields and self.run_pipeline:
            print("检测到业务建模字段（flow_class / is_core_infra / domain_source），自动跳过 Enricher Pipeline")
            self.run_pipeline = False

        # P2 v2: run the Pipeline first, then persist.
        if self.run_pipeline:
            print("\n--- Running Enricher Pipeline ---")
            cfg = Config.from_yaml(self.config_path)
            pl = Pipeline(cfg)
            print(f"  Enabled: {list(pl._enricher_pool.keys())}")
            self.pipeline_result = pl.run(nodes, links)
            res = self.pipeline_result
            print(f"  IPs: {len(res.ips)}  Services: {len(res.services)}  NewRels: {len(res.new_relationships)}")
            for n, st in sorted(res.enricher_stats.items()):
                print(f"    {n}: scanned={st['scanned']} ok={st['succeeded']} err={st['errors']}")
        else:
            # Fallback path: read original JSON entities directly without Pipeline.
            from enrichers.pipeline import _ip_from_dict
            res = type('R', (), {
                'ips': [_ip_from_dict(n) for n in nodes if n.get('type', 'IP') == 'IP'],
                'services': [],
                'new_relationships': [],
            })()

        print(f"\n--- {'Dry-run plan' if self.dry_run else 'Writing to Neo4j'} ---")
        s = None
        if self.driver is not None:
            s = self.driver.session()
        try:
            if s is not None:
                if self.clear_db:
                    self.clear(s)
                self.init_schema(s)
            self.import_ips(s, res.ips, cmdb_by_id)
            self.import_cmdb_dimensions(s, res.ips, cmdb_by_id)
            self.import_domain_zones(s, res.ips)
            self.import_services(s, res.services)
            self.import_runs_rels(s, res.new_relationships)
            self.import_links(s, links)
        finally:
            if s is not None:
                s.close()
        self.close()
        print("\nDone.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Import topology JSON into Neo4j")
    ap.add_argument("--input", default=JSON_PATH, help="path to topology JSON")
    ap.add_argument("--uri", default=URI, help="Neo4j bolt URI")
    ap.add_argument("--user", default=USER)
    ap.add_argument("--password", default=PASSWORD)
    ap.add_argument("--config", default=CONFIG_PATH, help="enrichers YAML config")
    ap.add_argument("--pipeline", action="store_true", help="force run the enricher pipeline")
    ap.add_argument("--no-pipeline", action="store_true", help="skip the enricher pipeline")
    ap.add_argument("--dry-run", action="store_true", help="plan only, do not connect to Neo4j")
    ap.add_argument("--no-clear", action="store_true", help="do not DETACH DELETE before importing")
    args = ap.parse_args()

    run_pipeline = args.pipeline or not args.no_pipeline
    importer = ClusterImporter(
        uri=args.uri,
        user=args.user,
        password=args.password,
        run_pipeline=run_pipeline,
        config_path=args.config,
        dry_run=args.dry_run,
        clear=not args.no_clear,
    )
    importer.run(args.input)
