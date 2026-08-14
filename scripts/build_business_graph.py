#!/usr/bin/env python3
"""Build a business-flow graph and a credibility-checked security-domain partition.

Step 1: detect core infrastructure hubs (nodes connecting to most of the graph)
Step 2: classify edge ports into infra / business / unknown
Step 3: build the business graph between non-hub nodes
Step 4: run Louvain + WCC on the business graph and emit metrics
"""
import json
import os
from collections import defaultdict, Counter
from pathlib import Path

BASE = Path(os.environ.get("CI_SCRIPT_BASE", Path(__file__).resolve().parent))
INPUT = BASE / "topology_data6.0.json"
OUTPUT_GRAPH = BASE / "topology_data_business.json"
OUTPUT_REPORT = BASE / "business_graph_report.json"

# 已确认的采集 / 汇聚 / 安全设备（来自原始日志的 dvchost/dvc 字段）
KNOWN_COLLECTOR_IPS = {"10.26.0.26", "10.20.3.25", "10.100.113.134"}

INFRA_PORTS = {
    22, 23, 53, 67, 68, 123, 135, 137, 139, 161, 162, 389, 445, 465,
    514, 5900, 5985, 5986, 636, 873, 1080, 1883, 2181, 2375, 2376,
    3389, 4444, 5044, 5601, 5672, 6514, 8086, 9090, 9092, 9093,
    9100, 9101, 9200, 9300, 61613, 61616, 18060, 22003, 36000,
}
BUSINESS_PORTS = {
    20, 21, 25, 80, 110, 143, 443, 587, 993, 995, 1433, 1521,
    2049, 3000, 3306, 3690, 5432, 6379, 7001, 8000, 8008, 8080,
    8443, 8888, 11211, 27017,
}


def port_class(port):
    try:
        p = int(port)
    except (TypeError, ValueError):
        return "unknown"
    if p in INFRA_PORTS:
        return "infra"
    if p in BUSINESS_PORTS:
        return "business"
    return "unknown"


def edge_classes(ports):
    if not ports:
        return ["unknown"]
    return sorted({port_class(p) for p in ports})


def main():
    with open(INPUT, encoding="utf-8") as f:
        data = json.load(f)
    nodes = data.get("nodes", [])
    links = data.get("links", [])
    ids = [n["id"] for n in nodes]

    adj = defaultdict(dict)
    port_of_edge = {}
    for l in links:
        u = l["source"] if isinstance(l["source"], str) else l["source"]["id"]
        v = l["target"] if isinstance(l["target"], str) else l["target"]["id"]
        if u == v:
            continue
        w = float(l.get("weight") or 1)
        adj[u][v] = adj[u].get(v, 0) + w
        adj[v][u] = adj[v].get(u, 0) + w
        key = tuple(sorted((u, v)))
        port_of_edge[key] = list(set(port_of_edge.get(key, []) + list(l.get("ports") or [])))

    total = len(ids)
    neighbor_count = {u: len(adj[u]) for u in ids}
    hub_threshold = max(50, int(total * 0.3))
    known_hubs = [u for u in KNOWN_COLLECTOR_IPS if u in ids]
    core_hubs = sorted(
        set(known_hubs) | {u for u in ids if neighbor_count[u] >= hub_threshold},
        key=lambda u: neighbor_count[u],
        reverse=True,
    )

    # Business edges between non-hub nodes
    hub_set = set(core_hubs)
    business_edges = []
    infra_edges = []
    hub_edges = []
    for (u, v), ports in port_of_edge.items():
        if u in hub_set or v in hub_set:
            hub_edges.append((u, v, ports))
            continue
        classes = edge_classes(ports)
        if classes == ["infra"]:
            infra_edges.append((u, v, ports))
        else:
            business_edges.append((u, v, ports))

    business_adj = defaultdict(dict)
    for u, v, ports in business_edges:
        w = adj[u][v]
        business_adj[u][v] = business_adj[u].get(v, 0) + w
        business_adj[v][u] = business_adj[v].get(u, 0) + w

    business_nodes = sorted({n for u, v, _ in business_edges for n in (u, v)})
    business_deg = {u: sum(business_adj[u].values()) for u in business_nodes}
    bm = sum(business_deg.values()) / 2.0

    def modularity(comm):
        tot = defaultdict(float)
        inner = defaultdict(float)
        for u, nbrs in business_adj.items():
            cu = comm[u]
            tot[cu] += business_deg[u]
            for v, w in nbrs.items():
                if comm[v] == cu and u < v:
                    inner[cu] += w
        q = 0.0
        for c in set(tot) | set(inner):
            q += inner[c] / bm - (tot[c] / (2 * bm)) ** 2
        return q

    def louvain():
        comm = {u: u for u in business_nodes}
        moved = True
        while moved:
            moved = False
            for u in business_nodes:
                nbr_comms = {comm[v] for v in business_adj.get(u, {})}
                cur = comm[u]
                best_c = cur
                best_q = modularity(comm)
                for c in nbr_comms:
                    if c == cur:
                        continue
                    comm[u] = c
                    q = modularity(comm)
                    if q > best_q + 1e-9:
                        best_q = q
                        best_c = c
                    comm[u] = cur
                if best_c != cur:
                    comm[u] = best_c
                    moved = True
        return comm, modularity(comm)

    if business_nodes:
        louv_comm, louv_q = louvain()
    else:
        louv_comm, louv_q = {}, 0.0

    # WCC on business graph
    seen = set()
    comps = []
    for u in business_nodes:
        if u in seen:
            continue
        stack = [u]
        comp = []
        while stack:
            x = stack.pop()
            if x in seen:
                continue
            seen.add(x)
            comp.append(x)
            stack.extend(business_adj[x].keys())
        comps.append(comp)
    comps.sort(key=len, reverse=True)

    # Final partition: core hubs + business communities + isolated nodes
    final_comm = {}
    for hub in core_hubs:
        final_comm[hub] = "core_infra"
    for u in business_nodes:
        final_comm[u] = "biz_%s" % louv_comm[u]
    isolated = [u for u in ids if u not in final_comm]
    for u in isolated:
        final_comm[u] = "isolated"

    sizes = Counter(final_comm.values())
    intra_w = 0.0
    total_biz_w = 0.0
    for u, v, _ in business_edges:
        w = adj[u][v]
        total_biz_w += w
        if final_comm[u] == final_comm[v]:
            intra_w += w

    report = {
        "input": str(INPUT),
        "totalNodes": len(ids),
        "totalLinks": len(links),
        "coreHubs": [
            {"id": h, "neighbors": neighbor_count[h], "weightedDegree": round(sum(adj[h].values()), 1)}
            for h in core_hubs
        ],
        "hubThreshold": hub_threshold,
        "knownCollectors": known_hubs,
        "edgeStats": {
            "hubEdges": len(hub_edges),
            "infraEdges": len(infra_edges),
            "businessEdges": len(business_edges),
        },
        "businessGraph": {
            "nodes": len(business_nodes),
            "edges": len(business_edges),
            "wccComponents": len(comps),
            "largestWcc": len(comps[0]) if comps else 0,
            "louvainCommunities": len(set(louv_comm.values())) if louv_comm else 0,
            "louvainModularity": round(louv_q, 4) if bm else 0,
            "intraEdgePct": round(intra_w / total_biz_w * 100, 1) if total_biz_w else 0.0,
        },
        "finalPartition": {
            "domainCount": len(sizes),
            "domainSizes": sorted(sizes.values(), reverse=True)[:20],
            "coreInfraNodes": len(core_hubs),
            "isolatedNodes": len(isolated),
        },
        "verdict": (
            "credible"
            if bm and louv_q >= 0.3
            else "not-credible"
        ),
    }

    out_nodes = []
    for n in nodes:
        nn = dict(n)
        nn["is_core_infra"] = n["id"] in hub_set
        nn["domain_source"] = final_comm.get(n["id"], "unknown")
        nn["business_degree"] = business_deg.get(n["id"], 0)
        out_nodes.append(nn)

    out_links = []
    for l in links:
        u = l["source"] if isinstance(l["source"], str) else l["source"]["id"]
        v = l["target"] if isinstance(l["target"], str) else l["target"]["id"]
        out_links.append(
            {
                **l,
                "flow_class": (
                    "core"
                    if u in hub_set or v in hub_set
                    else "business" if edge_classes(l.get("ports") or []) != ["infra"] else "infra"
                ),
            }
        )

    graph_out = {
        "metadata": {
            **data.get("metadata", {}),
            "source": "business_graph_model",
            "total_nodes": len(out_nodes),
            "total_links": len(out_links),
            "communities": len(sizes),
            "report": report,
        },
        "nodes": out_nodes,
        "links": out_links,
    }

    with open(OUTPUT_GRAPH, "w", encoding="utf-8") as f:
        json.dump(graph_out, f, ensure_ascii=False, indent=1)
    with open(OUTPUT_REPORT, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
