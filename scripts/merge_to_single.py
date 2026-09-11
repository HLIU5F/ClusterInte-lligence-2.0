#!/usr/bin/env python3
"""将 nodes_enriched.csv 与 relationships_enriched.csv 合并为单文件资产全景表"""
import csv
from collections import defaultdict

NODES_FILE = "nodes_enriched.csv"
RELS_FILE = "relationships_enriched.csv"
OUTPUT_FILE = "asset_panorama_merged.csv"

# 1. 读取关系并聚合
inbound = defaultdict(list)   # dst -> [(src, ports, proto, rel_type)]
outbound = defaultdict(list)  # src -> [(dst, ports, proto, rel_type)]

with open(RELS_FILE, 'r', encoding='utf-8') as f:
    reader = csv.DictReader(f)
    for row in reader:
        src, dst = row[':START_ID'], row[':END_ID']
        entry = (row['ports'], row['protocol'], row['relationship_type'])
        outbound[src].append((dst, *entry))
        inbound[dst].append((src, *entry))

def summarize(conns, max_items=5):
    """生成紧凑的连接摘要字符串"""
    if not conns:
        return ""
    items = []
    for peer, ports, proto, rel in conns[:max_items]:
        items.append(f"{peer}({proto}:{ports})")
    suffix = f"+{len(conns)-max_items}more" if len(conns) > max_items else ""
    return ";".join(items) + suffix

# 2. 读取节点并追加连接摘要
with open(NODES_FILE, 'r', encoding='utf-8') as fin, \
     open(OUTPUT_FILE, 'w', newline='', encoding='utf-8') as fout:
    reader = csv.DictReader(fin)
    fieldnames = reader.fieldnames + ['inbound_summary', 'outbound_summary', 
                                       'inbound_count', 'outbound_count']
    writer = csv.DictWriter(fout, fieldnames=fieldnames)
    writer.writeheader()
    
    for row in reader:
        node_id = row['id:ID']
        in_conns = inbound.get(node_id, [])
        out_conns = outbound.get(node_id, [])
        row['inbound_summary'] = summarize(in_conns)
        row['outbound_summary'] = summarize(out_conns)
        row['inbound_count'] = len(in_conns)
        row['outbound_count'] = len(out_conns)
        writer.writerow(row)

print(f"✅ 合并完成: {OUTPUT_FILE}")
print(f"   总行数: {sum(1 for _ in open(OUTPUT_FILE)) - 1}")
