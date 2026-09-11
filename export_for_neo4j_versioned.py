#!/usr/bin/env python3
"""
用法: python3 export_for_neo4j_versioned.py <input_json_path>
示例: python3 export_for_neo4j_versioned.py /root/cleaned_data/topology_20260911.json
输出: /root/cleaned_data/export_<input_basename_without_ext>/nodes_enriched.csv
      /root/cleaned_data/export_<input_basename_without_ext>/relationships_enriched.csv
"""
import sys, os, json, csv
from collections import defaultdict

if len(sys.argv) != 2:
    print("用法: python3 export_for_neo4j_versioned.py <input_json_path>")
    sys.exit(1)

INPUT_PATH = sys.argv[1]
if not os.path.isfile(INPUT_PATH):
    print(f"错误: 输入文件不存在: {INPUT_PATH}")
    sys.exit(1)

# 从输入文件名生成唯一输出目录
basename = os.path.splitext(os.path.basename(INPUT_PATH))[0]
OUTPUT_DIR = f"/root/cleaned_data/export_{basename}"
os.makedirs(OUTPUT_DIR, exist_ok=True)

print(f"📥 输入: {INPUT_PATH}")
print(f"📤 输出目录: {OUTPUT_DIR}")

# === 以下为原始逻辑，仅修改输出路径 ===
MONITOR_PORTS = {36000, 9100, 9101, 1514, 1515, 6514}
KNOWN_COLLECTOR_IPS = {'10.26.0.26', '10.20.3.25', '10.100.113.134'}
SERVICE_CLASS_LABELS = {
    'web': 'Web 服务', 'database': '数据库', 'cache': '缓存',
    'messaging': '消息队列', 'email': '邮件', 'remote': '远程管理',
    'dns': 'DNS', 'file_transfer': '文件传输', 'auth': '认证服务',
    'logging': '日志采集', 'monitoring': '监控', 'system': '系统服务', 'other': '其他'
}
ROLE_LABELS = {
    'server': '服务端', 'client': '客户端', 'hybrid': '混合角色',
    'collector': '采集节点', 'unknown': '未知'
}

def classify_port(port):
    if port in (80,443,8080,8443,8000,3000,5000,8888,9090): return 'web'
    if port in (3306,5432,1433,1521,27017,6379,9042,7000): return 'database'
    if port in (11211,6379,7000,7001): return 'cache'
    if port in (5672,9092,1883,61616,9093,11211): return 'messaging'
    if port in (25,110,143,587,993,995): return 'email'
    if port in (22,23,3389,5900,5901): return 'remote'
    if port in (53,853): return 'dns'
    if port in (21,20,69,115,2049): return 'file_transfer'
    if port in (88,389,636,1812,1813,8649): return 'auth'
    if port in (514,6514,9200,9300,8086,5044): return 'logging'
    if port in (161,162,9100,9101,9090): return 'monitoring'
    if port < 1024: return 'system'
    return 'other'

def get_subnet24(ip):
    parts = ip.split('.')
    return '.'.join(parts[:3]) if len(parts)==4 else ip

with open(INPUT_PATH) as f:
    data = json.load(f)

nodes = {n['id']: n for n in data['nodes']}
links = data['links']
total_nodes = len(nodes)

svc_anchors = defaultdict(set)
con_anchors = defaultdict(set)
anchor_callers = defaultdict(set)
anchor_peers = defaultdict(set)
neighbor_count = defaultdict(int)

for link in links:
    s, t = link['source'], link['target']
    for p in link.get('ports', []):
        if not isinstance(p, int) or p in MONITOR_PORTS:
            continue
        sk = f"{t}|{p}"
        anchor_callers[sk].add(get_subnet24(s))
        svc_anchors[t].add(sk)
        ck = f"{s}|{p}"
        anchor_peers[ck].add(get_subnet24(t))
        con_anchors[s].add(ck)
    neighbor_count[s] += 1
    neighbor_count[t] += 1

# Write enriched nodes CSV
nodes_out = os.path.join(OUTPUT_DIR, 'nodes_enriched.csv')
with open(nodes_out, 'w', newline='') as f:
    writer = csv.writer(f)
    writer.writerow(['id:ID', 'name', 'type', 'security_domain', 'subnet', 'role_guess', 'zone_id', 'zone_label'])
    for nid, node in nodes.items():
        nc = neighbor_count.get(nid, 0)
        if nid in KNOWN_COLLECTOR_IPS or nc >= max(50, int(total_nodes * 0.3)):
            zid, zlabel = 'flow_collector', '采集节点（监控/汇聚）'
            role = 'collector'
        else:
            svc_ports, callers = set(), set()
            for key in svc_anchors.get(nid, []):
                idx = key.rfind('|')
                svc_ports.add(int(key[idx+1:]))
                callers.update(anchor_callers.get(key, set()))
            con_ports, peers = set(), set()
            for key in con_anchors.get(nid, []):
                idx = key.rfind('|')
                con_ports.add(int(key[idx+1:]))
                peers.update(anchor_peers.get(key, set()))
            svc_classes = sorted(set(classify_port(p) for p in svc_ports) - {'other'})
            con_classes = sorted(set(classify_port(p) for p in con_ports) - {'other'})
            subnet = get_subnet24(nid)
            role = node.get('role_guess', 'unknown')
            role_tag = f"|role:{role}" if role != 'unknown' else ''
            role_label = f" · {ROLE_LABELS.get(role, role)}" if role != 'unknown' else ''
            if svc_classes:
                caller_key = ','.join(sorted(callers))
                zid = f"flow_svc_{'+' .join(svc_classes)}|{subnet}"
                if caller_key: zid += f"|callers:{caller_key}"
                zid += role_tag
                zlabel = f"{'+'.join(SERVICE_CLASS_LABELS.get(c,c) for c in svc_classes)} · {subnet}（服务提供）"
                if caller_key: zlabel += f" · 被 {caller_key} 调用"
                zlabel += role_label
            elif con_classes:
                peer_key = ','.join(sorted(peers))
                zid = f"flow_cli_{'+' .join(con_classes)}|{subnet}"
                if peer_key: zid += f"|peers:{peer_key}"
                zid += role_tag
                zlabel = f"{'+'.join(SERVICE_CLASS_LABELS.get(c,c) for c in con_classes)} 客户端 · {subnet}"
                if peer_key: zlabel += f" · 访问 {peer_key}"
                zlabel += role_label
            else:
                zid = f"flow_cli_none|{subnet}"
                zlabel = f"监控终端 · {subnet}"
        writer.writerow([nid, node['name'], node['type'], node['security_domain'],
                         get_subnet24(nid), role, zid, zlabel])

# Write relationships CSV
rels_out = os.path.join(OUTPUT_DIR, 'relationships_enriched.csv')
with open(rels_out, 'w', newline='') as f:
    writer = csv.writer(f)
    writer.writerow([':START_ID', ':END_ID', 'ports', 'protocol', 'relationship_type'])
    for link in links:
        ports_str = ';'.join(str(p) for p in sorted(link.get('ports', [])))
        writer.writerow([link['source'], link['target'], ports_str, 'tcp', 'ACCESSED'])

print(f"\n✅ Enriched CSVs generated in: {OUTPUT_DIR}")
for fn in ['nodes_enriched.csv', 'relationships_enriched.csv']:
    path = os.path.join(OUTPUT_DIR, fn)
    lines = sum(1 for _ in open(path)) - 1
    size = os.path.getsize(path)
    print(f"  {fn}: {lines} rows, {size/1024:.1f} KB")
