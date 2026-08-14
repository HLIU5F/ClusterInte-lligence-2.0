# ============ 配置参数 ============
CHUNK_SIZE = 100000
MIN_EDGE_WEIGHT = 3  # 提高最小边权重，只保留强连接
ANOMALY_CONTAMINATION = 0.03  # 进一步降低异常比例到 3%
RANDOM_SEED = 42

WHITELIST = {
    # "10.26.0.26": "日志收集服务器 (Logstash/Fluentd)，正常 hub 节点",
}

import sys
import json
import time
from pathlib import Path
from datetime import datetime
from collections import defaultdict

import pandas as pd
import numpy as np
import networkx as nx
from sklearn.ensemble import IsolationForest


# ============ 第一步：分块读取并聚合 ============
def aggregate_csv(csv_path):
    print(f"[1/5] 读取 CSV 文件：{csv_path}")
    
    edges = defaultdict(lambda: {"weight": 0, "bytes": 0, "ports": set()})
    node_in_degree = defaultdict(int)
    node_out_degree = defaultdict(int)
    node_ports = defaultdict(set)
    node_protocols = defaultdict(set)
    
    total_rows = 0
    start_time = time.time()
    
    for chunk_idx, chunk in enumerate(pd.read_csv(csv_path, chunksize=CHUNK_SIZE)):
        total_rows += len(chunk)
        
        required_cols = ['src', 'dst', 'dport']
        for col in required_cols:
            if col not in chunk.columns:
                print(f"错误：CSV 缺少必要列 '{col}'")
                return None, None, None
        
        chunk = chunk.dropna(subset=['src', 'dst'])
        chunk['src'] = chunk['src'].astype(str).str.strip()
        chunk['dst'] = chunk['dst'].astype(str).str.strip()
        chunk['dport'] = pd.to_numeric(chunk['dport'], errors='coerce').fillna(0).astype(int)
        
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
        
        elapsed = time.time() - start_time
        rows_per_sec = total_rows / elapsed if elapsed > 0 else 0
        print(f"      已处理 {total_rows:,} 行 ({rows_per_sec:,.0f} 行/秒)", end='\r')
    
    print(f"\n      总计：{total_rows:,} 行，耗时 {elapsed:.1f}s")
    print(f"      唯一节点：{len(node_ports):,}")
    print(f"      唯一边：{len(edges):,}")
    
    all_nodes = set(node_ports.keys())
    node_features = {}
    for node in all_nodes:
        in_deg = node_in_degree.get(node, 0)
        out_deg = node_out_degree.get(node, 0)
        node_features[node] = {
            "in_degree": in_deg,
            "out_degree": out_deg,
            "total_degree": in_deg + out_deg,
            "port_count": len(node_ports[node]),
            "ports": node_ports[node],
            "protocols": list(node_protocols.get(node, {"tcp"})),
        }
    
    return dict(edges), node_features, dict(node_ports)


# ============ 第二步：构建图（多阈值） ============
def build_graph(edges, min_weight=1):
    print(f"\n[2/5] 构建网络图 (最小边权重：{min_weight})")
    
    G = nx.Graph()
    
    for key, data in edges.items():
        if data["weight"] < min_weight:
            continue
        src, dst = key.split("|")
        G.add_edge(src, dst, weight=data["weight"], ports=list(data["ports"]))
    
    print(f"      节点数：{G.number_of_nodes()}")
    print(f"      边数：{G.number_of_edges()}")
    
    return G


# ============ 第三步：社区发现（基于强连接的连通分量） ============
def detect_communities(G, node_features=None, min_weight_for_community=5):
    print(f"\n[3/5] 社区发现")
    
    if G.number_of_nodes() == 0:
        return {}
    
    # 策略：用更高的边权重阈值构建子图，然后找连通分量
    # 这样只有强连接的节点才会被分到同一社区
    print(f"      使用强连接阈值 ({min_weight_for_community}) 划分社区...")
    
    # 创建强连接子图
    strong_edges = [(u, v) for u, v, d in G.edges(data=True) if d.get('weight', 0) >= min_weight_for_community]
    G_strong = nx.Graph()
    G_strong.add_nodes_from(G.nodes())
    G_strong.add_edges_from(strong_edges)
    
    # 找连通分量
    components = list(nx.connected_components(G_strong))
    
    # 过滤掉太小的分量（少于 3 个节点）
    large_components = [c for c in components if len(c) >= 3]
    small_nodes = set()
    for c in components:
        if len(c) < 3:
            small_nodes.update(c)
    
    # 将小分量节点分配到最近的强连接社区
    if small_nodes and large_components:
        for node in small_nodes:
            best_comp = None
            best_score = -1
            for i, comp in enumerate(large_components):
                # 计算该节点与组件的连接强度
                score = sum(G.get_edge_data(node, neighbor, {}).get('weight', 0) 
                           for neighbor in G.neighbors(node) if neighbor in comp)
                if score > best_score:
                    best_score = score
                    best_comp = i
            
            if best_comp is not None:
                large_components[best_comp].add(node)
            else:
                # 如果没有强连接，创建独立社区
                large_components.append({node})
    
    # 分配社区 ID
    node_community = {}
    for idx, comp in enumerate(large_components):
        for node in comp:
            node_community[node] = idx
    
    comm_count = len(large_components)
    print(f"      强连接分组：{comm_count} 个社区")
    
    # 如果社区数量还是太少，降低阈值重试
    if comm_count < 3 and min_weight_for_community > 2:
        print(f"      社区数量太少，降低阈值重试...")
        return detect_communities(G, node_features, min_weight_for_community - 2)
    
    return node_community


# ============ 第四步：智能域名生成 ============
def generate_domain_names(G, node_community, node_features):
    print(f"\n[4/5] 生成安全域名称")
    
    community_nodes = defaultdict(list)
    for node, comm in node_community.items():
        community_nodes[comm].append(node)
    
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
            return f"{parts[0]}.{parts[1]}.{parts[2]}"
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
        all_ports = set()
        for node in nodes:
            if node in G.nodes():
                for neighbor in G.neighbors(node):
                    edge_data = G.get_edge_data(node, neighbor)
                    if edge_data and 'ports' in edge_data:
                        all_ports.update(edge_data['ports'])
        
        role = get_role(all_ports)
        category = get_category(role)
        
        in_count = sum(node_features.get(n, {}).get("in_degree", 0) for n in nodes)
        out_count = sum(node_features.get(n, {}).get("out_degree", 0) for n in nodes)
        if in_count > out_count * 1.5:
            direction = "Receiver"
        elif out_count > in_count * 1.5:
            direction = "Sender"
        else:
            direction = "Mixed"
        
        subnets = [get_subnet(n) for n in nodes]
        main_subnet = max(set(subnets), key=subnets.count) if subnets else "unknown"
        
        name = f"{category}-{role}-{direction}-{main_subnet}-{comm_id}"
        domain_names[comm_id] = name
    
    return domain_names


# ============ 第五步：异常检测（降低比例） ============
def detect_anomalies(G, node_community, node_features):
    print(f"\n[5/5] 异常检测 (Isolation Forest, contamination={ANOMALY_CONTAMINATION})")
    
    nodes = list(G.nodes())
    if len(nodes) < 5:
        print("      节点太少，跳过异常检测")
        return {n: {"score": 0, "level": "normal"} for n in nodes}
    
    community_sizes = defaultdict(int)
    for n, c in node_community.items():
        community_sizes[c] += 1
    
    features = []
    for node in nodes:
        feat = node_features.get(node, {})
        degree = G.degree(node)
        comm_size = community_sizes.get(node_community.get(node, -1), 1)
        
        features.append([
            degree / max(G.number_of_nodes(), 1),
            feat.get("port_count", 0) / 100,
            comm_size / max(len(nodes), 1),
            degree / max(comm_size, 1),
            feat.get("in_degree", 0) / max(feat.get("out_degree", 1), 1),
        ])
    
    X = np.array(features)
    
    clf = IsolationForest(
        contamination=ANOMALY_CONTAMINATION,
        random_state=RANDOM_SEED,
        n_estimators=100
    )
    predictions = clf.fit_predict(X)
    scores = clf.score_samples(X)
    
    min_score = scores.min()
    max_score = scores.max()
    if max_score > min_score:
        normalized = (scores - min_score) / (max_score - min_score)
    else:
        normalized = np.zeros_like(scores)
    
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
        
        # 提高阈值
        if score > 0.90:
            level = "Critical"
            anomaly_count += 1
        elif score > 0.80:
            level = "High"
            anomaly_count += 1
        elif score > 0.65:
            level = "Medium"
        else:
            level = "Low"
        results[node] = {"score": round(score, 4), "level": level}
    
    print(f"      异常节点：{anomaly_count} / {len(nodes)} ({anomaly_count/len(nodes)*100:.1f}%)")
    if anomaly_count > 0:
        anomaly_nodes = [(n, r) for n, r in results.items() if r["level"] in ("Critical", "High")]
        anomaly_nodes.sort(key=lambda x: x[1]["score"], reverse=True)
        print(f"      前 10 个异常节点:")
        for node, info in anomaly_nodes[:10]:
            print(f"        {node}: score={info['score']:.3f} ({info['level']})")
    
    return results


# ============ 输出 JSON ============
def export_topology(G, node_community, node_features, domain_names, anomaly_results, output_path):
    print(f"\n导出拓扑数据到：{output_path}")
    
    nodes = []
    for node in G.nodes():
        feat = node_features.get(node, {})
        comm = node_community.get(node, 0)
        anomaly = anomaly_results.get(node, {"score": 0, "level": "normal"})
        
        nodes.append({
            "id": node,
            "community": comm,
            "degree": G.degree(node),
            "in_degree": feat.get("in_degree", 0),
            "out_degree": feat.get("out_degree", 0),
            "port_count": feat.get("port_count", 0),
            "protocols": feat.get("protocols", ["tcp"]),
            "anomaly_score": anomaly["score"],
            "anomaly_level": anomaly["level"],
            "is_anomaly": anomaly["level"] in ("Critical", "High"),
            "is_whitelisted": anomaly.get("is_whitelisted", False),
            "whitelist_reason": anomaly.get("whitelist_reason", ""),
            "label": node,
        })
    
    links = []
    for u, v, data in G.edges(data=True):
        links.append({
            "source": u,
            "target": v,
            "weight": data.get("weight", 1),
            "ports": data.get("ports", []),
        })
    
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
    print(f"      文件大小：{file_size / 1024:.1f} KB")
    print(f"      节点：{len(nodes)}, 边：{len(links)}, 社区：{metadata['communities']}")
    print(f"\n完成！将 {output_path} 导入到网页应用即可查看拓扑图。")


# ============ 运行 ============
csv_path = r"日志 - 网络访问关系导出数据.csv"
output_path = "topology_data.json"

if not Path(csv_path).exists():
    print(f"错误：文件不存在 - {csv_path}")
else:
    print("=" * 60)
    print("网络流量日志 → 拓扑数据 预处理工具")
    print("=" * 60)
    print(f"输入：{csv_path}")
    print(f"输出：{output_path}")
    print()
    
    total_start = time.time()
    
    edges, node_features, node_ports = aggregate_csv(csv_path)
    
    if edges is None:
        print("处理失败")
    else:
        G = build_graph(edges, min_weight=MIN_EDGE_WEIGHT)
        
        if G.number_of_nodes() == 0:
            print("错误：没有有效数据")
        else:
            node_community = detect_communities(G, node_features, min_weight_for_community=5)
            domain_names = generate_domain_names(G, node_community, node_features)
            anomaly_results = detect_anomalies(G, node_community, node_features)
            export_topology(G, node_community, node_features, domain_names, anomaly_results, output_path)
            
            total_time = time.time() - total_start
            print(f"\n总耗时：{total_time:.1f}s")
