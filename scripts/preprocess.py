#!/usr/bin/env python3
"""
大数据量网络流量日志预处理脚本
将 CSV 格式的原始流量日志转换为拓扑图 JSON 格式

用法:
    python preprocess.py <csv文件路径> [输出文件路径]

示例:
    python preprocess.py "日志-网络访问关系导出数据.csv"
    python preprocess.py "日志-网络访问关系导出数据.csv" output/topology.json

依赖安装:
    pip install pandas numpy scikit-learn networkx
"""

import sys
import json
import time
import hashlib
from pathlib import Path
from datetime import datetime
from collections import defaultdict

import pandas as pd
import numpy as np
import networkx as nx
from sklearn.ensemble import IsolationForest


# ============ 配置参数 ============
CHUNK_SIZE = 100000          # 每次读取的行数
MIN_EDGE_WEIGHT = 1          # 最小边权重（过滤低频连接）
ANOMALY_CONTAMINATION = 0.1  # 异常比例估计
RANDOM_SEED = 42

# 白名单配置 - 这些节点不会被标记为异常
# 格式：IP 地址 -> 原因说明
WHITELIST = {
    # "10.26.0.26": "日志收集服务器 (Logstash/Fluentd)，正常 hub 节点",
    # "10.20.3.25": "监控服务器，主动探测全网",
}


# ============ 第一步：分块读取并聚合 ============
def aggregate_csv(csv_path: str) -> tuple[dict, dict, dict]:
    """
    分块读取 CSV，聚合为边和节点特征
    返回: (edges_dict, node_features, node_ports)
    """
    print(f"[1/5] 读取 CSV 文件: {csv_path}")
    print(f"      分块大小: {CHUNK_SIZE} 行")
    
    edges = defaultdict(lambda: {"weight": 0, "bytes": 0, "ports": set()})
    node_in_degree = defaultdict(int)
    node_out_degree = defaultdict(int)
    node_ports = defaultdict(set)
    node_protocols = defaultdict(set)
    
    total_rows = 0
    start_time = time.time()
    
    for chunk_idx, chunk in enumerate(pd.read_csv(csv_path, chunksize=CHUNK_SIZE)):
        total_rows += len(chunk)
        
        # 只保留关键列
        required_cols = ['src', 'dst', 'dport']
        for col in required_cols:
            if col not in chunk.columns:
                print(f"错误: CSV 缺少必要列 '{col}'")
                print(f"当前列: {list(chunk.columns)}")
                sys.exit(1)
        
        # 清理空值
        chunk = chunk.dropna(subset=['src', 'dst'])
        chunk['src'] = chunk['src'].astype(str).str.strip()
        chunk['dst'] = chunk['dst'].astype(str).str.strip()
        chunk['dport'] = pd.to_numeric(chunk['dport'], errors='coerce').fillna(0).astype(int)
        
        # 聚合边
        for _, row in chunk.iterrows():
            src, dst, dport = row['src'], row['dst'], int(row['dport'])
            key = f"{src}|{dst}"
            edges[key]["weight"] += 1
            edges[key]["ports"].add(dport)
            
            node_ports[src].add(dport)
            node_ports[dst].add(dport)
            
            if 'proto' in chunk.columns:
                node_protocols[src].add(str(row.get('proto', 'tcp')))
                node_protocols[dst].add(str(row.get('proto', 'tcp')))
            
            if 'deviceDirection' in chunk.columns:
                direction = str(row.get('deviceDirection', ''))
                if direction == 'IN':
                    node_in_degree[dst] += 1
                    node_out_degree[src] += 1
                elif direction == 'OUT':
                    node_out_degree[dst] += 1
                    node_in_degree[src] += 1
                else:
                    node_in_degree[dst] += 1
                    node_out_degree[src] += 1
        
        # 进度显示
        elapsed = time.time() - start_time
        rows_per_sec = total_rows / elapsed if elapsed > 0 else 0
        print(f"      已处理 {total_rows:,} 行 ({rows_per_sec:,.0f} 行/秒)", end='\r')
    
    print(f"\n      总计: {total_rows:,} 行, 耗时 {elapsed:.1f}s")
    print(f"      唯一节点: {len(node_ports):,}")
    print(f"      唯一边: {len(edges):,}")
    
    # 构建节点特征
    all_nodes = set(node_ports.keys())
    node_features = {}
    for node in all_nodes:
        in_deg = node_in_degree.get(node, 0)
        out_deg = node_out_degree.get(node, 0)
        total_deg = in_deg + out_deg
        node_features[node] = {
            "in_degree": in_deg,
            "out_degree": out_deg,
            "total_degree": total_deg,
            "port_count": len(node_ports[node]),
            "ports": node_ports[node],  # Add ports set for community detection
            "protocols": list(node_protocols.get(node, {"tcp"})),
        }
    
    return dict(edges), node_features, dict(node_ports)


# ============ 第二步：构建图 ============
def build_graph(edges: dict, min_weight: int = 1) -> nx.Graph:
    """构建 NetworkX 图"""
    print(f"\n[2/5] 构建网络图 (最小边权重: {min_weight})")
    
    G = nx.Graph()
    
    for key, data in edges.items():
        if data["weight"] < min_weight:
            continue
        src, dst = key.split("|")
        G.add_edge(src, dst, weight=data["weight"], ports=list(data["ports"]))
    
    print(f"      节点数: {G.number_of_nodes()}")
    print(f"      边数: {G.number_of_edges()}")
    
    # 图密度
    density = nx.density(G)
    print(f"      图密度: {density:.4f}")
    
    return G


# ============ 第三步：社区发现 ============
def detect_communities(G: nx.Graph, node_features: dict = None) -> dict:
    """社区发现：边分组（按直接连接关系）"""
    print(f"\n[3/5] 社区发现")
    
    if G.number_of_nodes() == 0:
        return {}
    
    # 使用边分组（按直接连接关系）
    print(f"      使用边分组（按直接连接关系）...")
    node_community = edge_based_community_detection(G)
    comm_count = len(set(node_community.values()))
    print(f"      边分组：{comm_count} 个社区")
    return node_community


def edge_based_community_detection(G: nx.Graph) -> dict:
    """按节点间直接连接关系分组 - 基于子网的连通分量"""
    # 先按 /24 子网分组
    subnet_groups = defaultdict(set)
    for node in G.nodes():
        parts = node.split(".")
        if len(parts) == 4:
            subnet = f"{parts[0]}.{parts[1]}.{parts[2]}"
            subnet_groups[subnet].add(node)
        else:
            subnet_groups["unknown"].add(node)
    
    # 如果子网分组结果合理（2-100个），直接使用
    if 2 <= len(subnet_groups) <= 100:
        node_community = {}
        for idx, (subnet, nodes) in enumerate(subnet_groups.items()):
            for node in nodes:
                node_community[node] = idx
        return node_community
    
    # 否则使用连通分量
    components = list(nx.connected_components(G))
    
    # 合并过小的分量
    if len(components) > 50:
        components.sort(key=len, reverse=True)
        merged = []
        small_nodes = set()
        
        for comp in components:
            if len(comp) >= 5:
                merged.append(comp)
            else:
                small_nodes.update(comp)
        
        if small_nodes and merged:
            for node in small_nodes:
                best_comp = None
                best_score = -1
                for i, comp in enumerate(merged):
                    score = sum(1 for neighbor in G.neighbors(node) if neighbor in comp)
                    if score > best_score:
                        best_score = score
                        best_comp = i
                
                if best_comp is not None:
                    merged[best_comp].add(node)
                else:
                    merged.append({node})
        
        components = merged
    
    node_community = {}
    for idx, comp in enumerate(components):
        for node in comp:
            node_community[node] = idx
    
    return node_community


def rule_based_community_detection(G: nx.Graph, node_features: dict) -> dict:
    """基于规则的细粒度社区划分：子网段 + 端口范围 + 角色 + 方向"""
    PORT_ROLES = {
        (80, 443, 8080, 8443): "WebTier",
        (3306, 5432, 1521, 1433, 27017): "Database",
        (6379, 11211, 6380): "Cache",
        (9092, 9093, 9094, 2181): "Middleware",
        (514, 1514): "Syslog",
        (8086, 9200, 9300): "Monitor",
        (22, 3389): "Management",
        (53, 88, 389, 636): "Infra",
        (5672, 15672, 61616): "MQ",
    }
    
    def get_port_range(ports):
        has_web = any(p in (80, 443, 8080, 8443) for p in ports)
        has_db = any(p in (3306, 5432, 1521, 1433, 27017) for p in ports)
        has_cache = any(p in (6379, 11211, 6380) for p in ports)
        has_mq = any(p in (9092, 9093, 9094, 2181, 5672) for p in ports)
        has_monitor = any(p in (36000, 9100, 7070, 9000, 8086, 9200) for p in ports)
        has_syslog = any(p in (514, 1514, 1516, 1517) for p in ports)
        has_infra = any(p in (22, 53, 88, 389, 636) for p in ports)
        
        ranges = []
        if has_web: ranges.append('Web')
        if has_db: ranges.append('DB')
        if has_cache: ranges.append('Cache')
        if has_mq: ranges.append('MQ')
        if has_monitor: ranges.append('Mon')
        if has_syslog: ranges.append('Syslog')
        if has_infra: ranges.append('Infra')
        
        return '+'.join(ranges) if ranges else 'Other'
    
    def get_role(ports):
        for port_set, role in PORT_ROLES.items():
            if any(p in port_set for p in ports):
                return role
        return "General"
    
    def get_subnet(ip):
        parts = ip.split(".")
        if len(parts) == 4:
            return f"{parts[0]}.{parts[1]}.{parts[2]}"
        return "unknown"
    
    def get_direction(feat):
        in_deg = feat.get("in_degree", 0)
        out_deg = feat.get("out_degree", 0)
        if in_deg > out_deg * 1.5:
            return "Receiver"
        elif out_deg > in_deg * 1.5:
            return "Sender"
        return "Mixed"
    
    profile_map = {}
    node_community = {}
    profile_id = 0
    
    for node in G.nodes():
        feat = node_features.get(node, {})
        ports = feat.get("ports", set())
        subnet = get_subnet(node)
        port_range = get_port_range(ports)
        role = get_role(ports)
        direction = get_direction(feat)
        
        profile = f"{subnet}-{port_range}-{role}-{direction}"
        
        if profile not in profile_map:
            profile_map[profile] = profile_id
            profile_id += 1
        
        node_community[node] = profile_map[profile]
    
    return node_community


def subnet_based_community_detection(G: nx.Graph) -> dict:
    """按 /24 子网分组 - 最激进但保证产生多个社区"""
    subnet_map = {}
    node_community = {}
    comm_id = 0
    
    for node in G.nodes():
        parts = node.split(".")
        if len(parts) == 4:
            subnet = f"{parts[0]}.{parts[1]}.{parts[2]}"
        else:
            subnet = node
        
        if subnet not in subnet_map:
            subnet_map[subnet] = comm_id
            comm_id += 1
        
        node_community[node] = subnet_map[subnet]
    
    return node_community


# ============ 第四步：智能域名生成 ============
def generate_domain_names(G: nx.Graph, node_community: dict, node_features: dict) -> dict:
    """为每个社区生成有意义的名称"""
    print(f"\n[4/5] 生成安全域名称")
    
    # 按社区分组
    community_nodes = defaultdict(list)
    for node, comm in node_community.items():
        community_nodes[comm].append(node)
    
    # 端口号 → 角色映射
    PORT_ROLES = {
        (80, 443, 8080, 8443): "WebTier",
        (3306, 5432, 1521, 1433, 27017): "Database",
        (6379, 11211, 6380): "Cache",
        (9092, 9093, 9094, 2181): "Middleware",
        (514, 1514): "Syslog",
        (8086, 9200, 9300): "Monitor",
        (22, 3389): "Management",
        (53, 88, 389, 636): "Infra",
        (5672, 15672, 61616): "MQ",
    }
    
    def get_role(ports):
        for port_set, role in PORT_ROLES.items():
            if any(p in port_set for p in ports):
                return role
        return "General"
    
    def get_subnet(ip):
        parts = ip.split(".")
        if len(parts) == 4:
            return f"{parts[0]}.{parts[1]}.{parts[2]}"  # /24 subnet for finer granularity
        return "unknown"
    
    def get_category(role):
        if role in ("WebTier", "Middleware", "Cache", "MQ"):
            return "App"
        elif role in ("Database", "Syslog", "Monitor"):
            return "Biz"
        else:
            return "Infra"
    
    domain_names = {}
    for comm_id, nodes in community_nodes.items():
        # 收集所有端口
        all_ports = set()
        for node in nodes:
            if node in G.nodes():
                for neighbor in G.neighbors(node):
                    edge_data = G.get_edge_data(node, neighbor)
                    if edge_data and 'ports' in edge_data:
                        all_ports.update(edge_data['ports'])
        
        role = get_role(all_ports)
        category = get_category(role)
        
        # 主方向
        in_count = sum(node_features.get(n, {}).get("in_degree", 0) for n in nodes)
        out_count = sum(node_features.get(n, {}).get("out_degree", 0) for n in nodes)
        if in_count > out_count * 1.5:
            direction = "Receiver"
        elif out_count > in_count * 1.5:
            direction = "Sender"
        else:
            direction = "Mixed"
        
        # 主网段（/24）
        subnets = [get_subnet(n) for n in nodes]
        main_subnet = max(set(subnets), key=subnets.count) if subnets else "unknown"
        
        # 包含子网段以更好区分
        name = f"{category}-{role}-{direction}-{main_subnet}-{comm_id}"
        domain_names[comm_id] = name
    
    return domain_names


# ============ 第五步：异常检测 ============
def detect_anomalies(G: nx.Graph, node_community: dict, node_features: dict) -> dict:
    """Isolation Forest 异常检测"""
    print(f"\n[5/5] 异常检测 (Isolation Forest)")
    
    nodes = list(G.nodes())
    if len(nodes) < 5:
        print("      节点太少，跳过异常检测")
        return {n: {"score": 0, "level": "normal"} for n in nodes}
    
    # 构建特征矩阵
    community_sizes = defaultdict(int)
    for n, c in node_community.items():
        community_sizes[c] += 1
    
    features = []
    for node in nodes:
        feat = node_features.get(node, {})
        degree = G.degree(node)
        comm_size = community_sizes.get(node_community.get(node, -1), 1)
        
        features.append([
            degree / max(G.number_of_nodes(), 1),  # 度中心性
            feat.get("port_count", 0) / 100,         # 端口多样性
            comm_size / max(len(nodes), 1),           # 社区大小
            degree / max(comm_size, 1),               # 度/社区比
            feat.get("in_degree", 0) / max(feat.get("out_degree", 1), 1),  # 入出比
        ])
    
    X = np.array(features)
    
    # Isolation Forest
    clf = IsolationForest(
        contamination=ANOMALY_CONTAMINATION,
        random_state=RANDOM_SEED,
        n_estimators=100
    )
    predictions = clf.fit_predict(X)
    scores = clf.score_samples(X)
    
    # 归一化分数到 [0, 1]
    min_score = scores.min()
    max_score = scores.max()
    if max_score > min_score:
        normalized = (scores - min_score) / (max_score - min_score)
    else:
        normalized = np.zeros_like(scores)
    
    # Isolation Forest: score 越低越异常，反转
    anomaly_scores = 1 - normalized
    
    results = {}
    anomaly_count = 0
    for i, node in enumerate(nodes):
        score = float(anomaly_scores[i])
        
        # 检查白名单
        if node in WHITELIST:
            results[node] = {
                "score": 0.0,
                "level": "None",
                "is_whitelisted": True,
                "whitelist_reason": WHITELIST[node],
            }
            continue
        
        if score > 0.75:
            level = "Critical"
            anomaly_count += 1
        elif score > 0.6:
            level = "High"
            anomaly_count += 1
        elif score > 0.4:
            level = "Medium"
        else:
            level = "Low"
        results[node] = {"score": round(score, 4), "level": level}
    
    print(f"      异常节点: {anomaly_count} / {len(nodes)}")
    if anomaly_count > 0:
        anomaly_nodes = [(n, r) for n, r in results.items() if r["level"] != "normal"]
        anomaly_nodes.sort(key=lambda x: x[1]["score"], reverse=True)
        for node, info in anomaly_nodes[:5]:
            print(f"        {node}: score={info['score']:.3f} ({info['level']})")
    
    return results


# ============ 输出 JSON ============
def export_topology(G: nx.Graph, node_community: dict, node_features: dict,
                    domain_names: dict, anomaly_results: dict, output_path: str):
    """导出拓扑 JSON"""
    print(f"\n导出拓扑数据到: {output_path}")
    
    # 构建节点列表
    nodes = []
    for node in G.nodes():
        feat = node_features.get(node, {})
        comm = node_community.get(node, 0)
        anomaly = anomaly_results.get(node, {"score": 0, "level": "normal"})
        
        # 计算字节数（估算：每条连接约 1KB）
        degree = G.degree(node)
        bytes_sent = feat.get("out_degree", 0) * 1024
        bytes_received = feat.get("in_degree", 0) * 1024
        
        # 根据端口猜测角色
        ports = feat.get("ports", set())
        role_guess = "unknown"
        if any(p in (80, 443, 8080, 8443) for p in ports):
            role_guess = "web_server"
        elif any(p in (3306, 5432, 1521, 1433, 27017) for p in ports):
            role_guess = "database"
        elif any(p in (6379, 11211, 6380) for p in ports):
            role_guess = "cache"
        elif any(p in (9092, 9093, 9094, 2181, 5672) for p in ports):
            role_guess = "message_queue"
        elif any(p in (514, 1514) for p in ports):
            role_guess = "monitoring"
        
        nodes.append({
            "id": node,
            "community": comm,
            "degree": degree,
            "in_degree": feat.get("in_degree", 0),
            "out_degree": feat.get("out_degree", 0),
            "port_count": feat.get("port_count", 0),
            "protocols": feat.get("protocols", ["tcp"]),
            "bytes_sent": bytes_sent,
            "bytes_received": bytes_received,
            "role_guess": role_guess,
            "anomaly_score": anomaly["score"],
            "anomaly_level": anomaly["level"],
            "is_anomaly": anomaly["level"] in ("Critical", "High"),
            "is_whitelisted": anomaly.get("is_whitelisted", False),
            "whitelist_reason": anomaly.get("whitelist_reason", ""),
            "label": node,
        })
    
    # 构建边列表
    links = []
    for u, v, data in G.edges(data=True):
        links.append({
            "source": u,
            "target": v,
            "weight": data.get("weight", 1),
            "ports": data.get("ports", []),
        })
    
    # 元数据
    metadata = {
        "generated_at": datetime.now().isoformat(),
        "source": "csv_preprocess",
        "total_nodes": len(nodes),
        "total_links": len(links),
        "communities": len(set(node_community.values())),
        "anomaly_count": sum(1 for r in anomaly_results.values() if r["level"] in ("Critical", "High")),
    }
    
    result = {
        "metadata": metadata,
        "nodes": nodes,
        "links": links,
        "domainNames": domain_names,
        "whitelist": [{"ip": ip, "reason": reason} for ip, reason in WHITELIST.items()],
    }
    
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    
    file_size = Path(output_path).stat().st_size
    print(f"      文件大小: {file_size / 1024:.1f} KB")
    print(f"      节点: {len(nodes)}, 边: {len(links)}, 社区: {metadata['communities']}")
    print(f"\n✅ 完成！将 {output_path} 导入到网页应用即可查看拓扑图。")


# ============ 主流程 ============
csv_path = sys.argv[1] if len(sys.argv) > 1 else r"scripts/日志-网络访问关系导出数据.csv"
def main():
   # 如果传了参数就用参数，否则用默认值
 print(f"正在读取数据文件: {csv_path}")
           
try:
                # 读取 CSV 文件
                df = pd.read_csv(csv_path)
                
                # 将 DataFrame 转换为字典列表，方便后续遍历
                # orient='records' 会生成 [{'col1': val, 'col2': val}, ...] 的格式
                nodes_data = df.to_dict(orient='records')
                
                print(f"成功加载 {len(nodes_data)} 条节点数据。")
except Exception as e:
                print(f"❌ 读取文件失败: {e}")
        # ==========================================
        # 7. 应用丰富器
        # ==========================================
                print(f"\n🔧 正在应用丰富器...")
        
                # 导入丰富器
                from enrichers.base import BaseEnricher
                from enrichers.ip_geo import IPGeoEnricher
                from enrichers.service_type import ServiceTypeEnricher
                
                # 创建丰富器实例
                enrichers = [
                    IPGeoEnricher(),
                    ServiceTypeEnricher(),
                ]
                
def main():
    # 如果传了参数就用参数，否则用默认值
    csv_path = sys.argv[1] if len(sys.argv) > 1 else r"scripts/日志-网络访问关系导出数据.csv"
    
    print(f"正在读取数据文件：{csv_path}")
    
    try:
        # 读取 CSV 文件
        df = pd.read_csv(csv_path)
        
        # 将 DataFrame 转换为字典列表
        nodes_data = df.to_dict(orient='records')
        
        print(f"成功加载 {len(nodes_data)} 条节点数据。")
        
        # ==========================================
        # 7. 应用丰富器
        # ==========================================
        print(f"\n🔧 正在应用丰富器...")
        
        # 导入丰富器
        from enrichers.base import BaseEnricher
        from enrichers.ip_geo import IPGeoEnricher
        from enrichers.service_type import ServiceTypeEnricher
        
        # 创建丰富器实例
        enrichers = [
            IPGeoEnricher(),
            ServiceTypeEnricher(),
        ]
        
        # 过滤启用的丰富器
        enabled_enrichers = [e for e in enrichers if e.enabled]
        print(f"      启用 {len(enabled_enrichers)} 个丰富器：{[e.name for e in enabled_enrichers]}")
        
        # 应用丰富器
        for node in nodes_data:
            for enricher in enabled_enrichers:
                try:
                    node = enricher.enrich(node)
                except Exception as e:
                    print(f"      ⚠️ {enricher.name} 处理 {node.get('id', 'unknown')} 失败：{e}")
        
        print(f"✅ 丰富器应用完成")
        
    except Exception as e:
        print(f"❌ 读取文件失败：{e}")
        return

if len(sys.argv) < 2:
                    print("用法: python preprocess.py <csv文件路径> [输出文件路径]")
                    print("示例: python preprocess.py '日志-网络访问关系导出数据.csv'")
                    sys.exit(1)
                
csv_path = sys.argv[1]
output_path = sys.argv[2] if len(sys.argv) > 2 else "topology_data.json"
                
if not Path(csv_path).exists():
                    print(f"错误: 文件不存在 - {csv_path}")
                    sys.exit(1)
            
print("=" * 60)
print("网络流量日志 → 拓扑数据 预处理工具")
print("=" * 60)
print(f"输入: {csv_path}")
print(f"输出: {output_path}")
print()
    
otal_start = time.time()
    
    # 1. 聚合
edges, node_features, node_ports = aggregate_csv(csv_path)
    
    # 2. 构建图
G = build_graph(edges, min_weight=MIN_EDGE_WEIGHT)
    
if G.number_of_nodes() == 0:
         print("错误: 没有有效数据")
sys.exit(1)
    
    # 3. 社区发现
node_community = detect_communities(G, node_features)
    
    # 4. 域名生成
domain_names = generate_domain_names(G, node_community, node_features)
    
    # 5. 异常检测
anomaly_results = detect_anomalies(G, node_community, node_features)
    
    # 6. 导出
export_topology(G, node_community, node_features, domain_names, anomaly_results, output_path)
    
total_time = time.time() - total_start
print(f"\n总耗时: {total_time:.1f}s")

if __name__ == "__main__":
     main()
