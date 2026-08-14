"""
port_service enricher
端口 → 具体协议/服务名 → 生成 (Service) 节点 + (:IP)-[:RUNS]->(Service) 关系

意图：
- 80 / HTTP, 443 / HTTPS, 3306 / MySQL, 6379 / Redis
- 让图里能看见 "这台 IP 跑了什么服务"，而不只是端口
"""
from __future__ import annotations

from .base import BaseEnricher, safe_result
from .registry import enricher
from .types import IPEntity, ServiceEntity, EnrichmentResult


# 端口 → (协议名, category)
WELL_KNOWN_PORTS: dict[int, tuple[str, str]] = {
    20: ("FTP-data", "FileTransfer"),
    21: ("FTP", "FileTransfer"),
    22: ("SSH", "RemoteAccess"),
    23: ("Telnet", "RemoteAccess"),
    25: ("SMTP", "Mail"),
    53: ("DNS", "Infra"),
    67: ("DHCP", "Infra"),
    68: ("DHCP", "Infra"),
    80: ("HTTP", "Web"),
    110: ("POP3", "Mail"),
    123: ("NTP", "Infra"),
    135: ("RPC", "Infra"),
    137: ("NetBIOS", "Infra"),
    139: ("NetBIOS", "Infra"),
    143: ("IMAP", "Mail"),
    161: ("SNMP", "Monitoring"),
    389: ("LDAP", "Infra"),
    443: ("HTTPS", "Web"),
    445: ("SMB", "FileTransfer"),
    465: ("SMTPS", "Mail"),
    514: ("Syslog", "Logging"),
    515: ("LPR", "Infra"),
    587: ("Submission", "Mail"),
    636: ("LDAPS", "Infra"),
    873: ("Rsync", "FileTransfer"),
    993: ("IMAPS", "Mail"),
    995: ("POP3S", "Mail"),
    1080: ("SOCKS", "Infra"),
    1433: ("MSSQL", "Database"),
    1521: ("Oracle", "Database"),
    1883: ("MQTT", "MQ"),
    2049: ("NFS", "FileTransfer"),
    2181: ("Zookeeper", "MQ"),
    2375: ("Docker", "Container"),
    2376: ("Docker-TLS", "Container"),
    3306: ("MySQL", "Database"),
    3389: ("RDP", "RemoteAccess"),
    3690: ("SVN", "VCS"),
    4444: ("Metasploit", "SecurityTest"),  # 标记为可疑
    5000: ("UPNP", "Storage"),
    5060: ("SIP", "VoIP"),
    5432: ("PostgreSQL", "Database"),
    5601: ("Kibana", "Monitoring"),
    5672: ("AMQP", "MQ"),
    5900: ("VNC", "RemoteAccess"),
    5985: ("WinRM-HTTP", "RemoteAccess"),
    5986: ("WinRM-HTTPS", "RemoteAccess"),
    6379: ("Redis", "Cache"),
    7001: ("WebLogic", "Web"),
    8000: ("HTTP-Alt", "Web"),
    8008: ("HTTP-Alt", "Web"),
    8080: ("HTTP-Alt", "Web"),
    8086: ("InfluxDB", "Monitoring"),
    8088: ("Django-Dev", "Web"),
    8443: ("HTTPS-Alt", "Web"),
    8500: ("Consul", "Infra"),
    8888: ("HTTP-Alt", "Web"),
    9000: ("PHP-FPM", "Web"),
    9090: ("Prometheus", "Monitoring"),
    9092: ("Kafka", "MQ"),
    9100: ("Node-Exporter", "Monitoring"),
    9200: ("Elasticsearch", "Database"),
    9300: ("Elasticsearch-Transport", "Database"),
    11211: ("Memcached", "Cache"),
    15672: ("RabbitMQ-Management", "MQ"),
    27017: ("MongoDB", "Database"),
    61613: ("ActiveMQ-Stomp", "MQ"),
    61616: ("ActiveMQ-OpenWire", "MQ"),
    # 采集 / 汇聚设备常见端口（日志中确认的主机名 spcwp01els02、isa5）
    36000: ("UPShield-Collector", "Logging"),
    18060: ("ISA-Collector", "Monitoring"),
    22003: ("ISA-Service", "Infra"),
}


@enricher
class PortServiceEnricher(BaseEnricher):
    name = "port_service"
    category = "Service"
    description = "端口 → 具体协议名（80/HTTP、3306/MySQL …）+ 创建 (:Service) 节点"
    applicable_type = "IP"

    include_unknown: bool = True   # 词典里查不到的端口是否也算一个未知 Service 节点

    def postprocess(self, raw, entity: IPEntity) -> EnrichmentResult:
        new_rels = []
        new_entities = []

        for port in (entity.ports or []):
            try:
                port = int(port)
            except (TypeError, ValueError):
                continue
            if port <= 0 or port > 65535:
                continue

            if port in WELL_KNOWN_PORTS:
                name, cat = WELL_KNOWN_PORTS[port]
            else:
                if not self.include_unknown:
                    continue
                name = f"Port-{port}"
                cat = "Unknown"

            svc_id = f"{name}@{port}"
            new_entities.append(ServiceEntity(
                id=svc_id,
                name=name,
                port=port,
                category=cat,
            ))
            new_rels.append({
                "type": "RUNS",
                "target": svc_id,
                "target_type": "Service",
            })

        return EnrichmentResult(
            properties={"open_port_count": len(new_entities)},
            relationships=new_rels,
            new_entities=new_entities,
        )
