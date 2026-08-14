#!/usr/bin/env python3
"""Analyze a raw topology file, remove large hub nodes, and emit an importable graph.

Example:
    python scripts/remove_large_nodes.py
    python scripts/remove_large_nodes.py --mode all
    python scripts/remove_large_nodes.py --remove 10.26.0.26 10.20.3.25
    python scripts/remove_large_nodes.py --output topology_data_no_hubs.json --public
"""
import argparse
import json
import os
import sys
from collections import Counter, defaultdict
from pathlib import Path

BASE = Path(os.environ.get("CI_SCRIPT_BASE", Path(__file__).resolve().parent))
DEFAULT_INPUT = BASE / "topology_data6.0.json"
DEFAULT_OUTPUT_CORE = BASE / "topology_data_core.json"
DEFAULT_OUTPUT_ALL = BASE / "topology_data_no_hubs.json"
DEFAULT_REPORT = BASE / "remove_large_nodes_report.json"
DEFAULT_REMOVE = ["10.26.0.26", "10.20.3.25"]


def node_id(value):
    if isinstance(value, str):
        return value
    return value.get("id", "")


def analyze(data):
    nodes = data.get("nodes", [])
    links = data.get("links", [])
    ids = [n["id"] for n in nodes]

    neighbors = defaultdict(set)
    weighted = defaultdict(float)
    for link in links:
        u = node_id(link.get("source"))
        v = node_id(link.get("target"))
        if u == v:
            continue
        w = float(link.get("weight") or 1)
        neighbors[u].add(v)
        neighbors[v].add(u)
        weighted[u] += w
        weighted[v] += w

    stats = []
    for n in nodes:
        stats.append(
            {
                "id": n["id"],
                "uniqueNeighbors": len(neighbors.get(n["id"], set())),
                "linkCount": sum(1 for l in links if node_id(l.get("source")) == n["id"] or node_id(l.get("target")) == n["id"]),
                "weightedDegree": round(weighted.get(n["id"], 0.0), 1),
                "community": n.get("community"),
            }
        )
    stats.sort(key=lambda x: (x["uniqueNeighbors"], x["weightedDegree"]), reverse=True)
    return nodes, links, ids, stats


def connected_components(ids, links):
    adj = defaultdict(set)
    for link in links:
        u = node_id(link.get("source"))
        v = node_id(link.get("target"))
        if u == v:
            continue
        adj[u].add(v)
        adj[v].add(u)
    comp_id = {}
    comp = 0
    for start in ids:
        if start in comp_id:
            continue
        stack = [start]
        comp_id[start] = comp
        while stack:
            cur = stack.pop()
            for nxt in adj.get(cur, set()):
                if nxt not in comp_id:
                    comp_id[nxt] = comp
                    stack.append(nxt)
        comp += 1
    return comp_id


def main():
    parser = argparse.ArgumentParser(description="Remove large hub nodes from raw topology data.")
    parser.add_argument("--input", default=str(DEFAULT_INPUT), help="Input topology JSON")
    parser.add_argument("--output", default=None, help="Output topology JSON")
    parser.add_argument("--report", default=str(DEFAULT_REPORT), help="Output analysis report JSON")
    parser.add_argument("--remove", nargs="+", default=DEFAULT_REMOVE, help="Node IDs to remove")
    parser.add_argument("--public", action="store_true", help="Also write to public/topology_data_no_hubs.json")
    parser.add_argument(
        "--mode",
        choices=["core", "all"],
        default="core",
        help="core: keep only nodes with remaining business links; all: keep every non-hub node",
    )
    args = parser.parse_args()

    if args.output is None:
        args.output = str(DEFAULT_OUTPUT_CORE if args.mode == "core" else DEFAULT_OUTPUT_ALL)

    input_path = Path(args.input)
    if not input_path.exists():
        print("Input file not found: %s" % input_path)
        sys.exit(1)

    with open(input_path, encoding="utf-8") as f:
        data = json.load(f)

    nodes, links, ids, stats = analyze(data)
    print("Input: %d nodes / %d links" % (len(nodes), len(links)))
    print("Largest nodes by unique neighbors:")
    for s in stats[:10]:
        print("  %-18s neighbors=%-5d links=%-5d weighted=%-12.1f community=%s" % (
            s["id"], s["uniqueNeighbors"], s["linkCount"], s["weightedDegree"], s["community"]
        ))

    remove_set = set(args.remove)
    present_remove = remove_set & set(ids)
    missing_remove = remove_set - set(ids)
    if missing_remove:
        print("WARNING: not found in data: %s" % ", ".join(sorted(missing_remove)))
    if not present_remove:
        print("Nothing to remove, output would be unchanged.")

    keep_ids = set(ids) - present_remove
    removed_nodes = [n for n in nodes if n["id"] in present_remove]
    kept_nodes = [n for n in nodes if n["id"] in keep_ids]
    removed_link_count = 0
    kept_links = []
    for link in links:
        u = node_id(link.get("source"))
        v = node_id(link.get("target"))
        if u in present_remove or v in present_remove:
            removed_link_count += 1
            continue
        kept_links.append(link)

    # Recompute degrees on the remaining graph.
    neighbor_set = defaultdict(set)
    out_deg = Counter()
    in_deg = Counter()
    for link in kept_links:
        u = node_id(link.get("source"))
        v = node_id(link.get("target"))
        if u == v:
            continue
        neighbor_set[u].add(v)
        neighbor_set[v].add(u)
        out_deg[u] += 1
        in_deg[v] += 1

    # core mode: keep only nodes that still have business links after hub removal.
    dropped_isolated = set()
    if args.mode == "core":
        dropped_isolated = {nid for nid in keep_ids if not neighbor_set.get(nid)}
        keep_ids -= dropped_isolated
        kept_nodes = [n for n in kept_nodes if n["id"] in keep_ids]
        kept_links = [
            link
            for link in kept_links
            if node_id(link.get("source")) in keep_ids and node_id(link.get("target")) in keep_ids
        ]

    # Preserve the service-port signal from all original flows, including collector edges.
    node_ports = defaultdict(set)
    for link in links:
        u = node_id(link.get("source"))
        v = node_id(link.get("target"))
        for p in link.get("ports") or []:
            try:
                port = int(p)
            except (TypeError, ValueError):
                continue
            if u in keep_ids:
                node_ports[u].add(port)
            if v in keep_ids:
                node_ports[v].add(port)

    comp_id = connected_components(list(keep_ids), kept_links)
    comp_sizes = Counter(comp_id.values())
    isolated_count = sum(1 for size in comp_sizes.values() if size == 1)

    out_nodes = []
    for n in kept_nodes:
        nn = dict(n)
        nn["community"] = comp_id.get(n["id"], 0)
        nn["degree"] = len(neighbor_set.get(n["id"], set()))
        nn["in_degree"] = in_deg.get(n["id"], 0)
        nn["out_degree"] = out_deg.get(n["id"], 0)
        nn["ports"] = sorted(node_ports.get(n["id"], set()))
        nn["business_degree"] = len(neighbor_set.get(n["id"], set()))
        out_nodes.append(nn)

    port_signatures = Counter(tuple(sorted(node_ports.get(n["id"], set()))) for n in out_nodes)

    report = {
        "input": str(input_path),
        "output": str(args.output),
        "mode": args.mode,
        "removedNodes": [
            {
                "id": n["id"],
                "community": n.get("community"),
                "originalDegree": n.get("degree"),
                "originalUniqueNeighbors": next((s["uniqueNeighbors"] for s in stats if s["id"] == n["id"]), 0),
                "originalLinkCount": next((s["linkCount"] for s in stats if s["id"] == n["id"]), 0),
            }
            for n in removed_nodes
        ],
        "before": {"nodes": len(nodes), "links": len(links)},
        "after": {"nodes": len(out_nodes), "links": len(kept_links)},
        "removedLinks": removed_link_count,
        "droppedIsolatedNodes": len(dropped_isolated),
        "nodeSignal": {
            "keptNodes": len(out_nodes),
            "withPorts": sum(1 for n in out_nodes if n.get("port_count", 0) > 0 or n.get("ports")),
            "withProtocols": sum(1 for n in out_nodes if n.get("protocols")),
            "withAnomalySignal": sum(1 for n in out_nodes if n.get("is_anomaly") is True or n.get("anomaly_level") in ("Critical", "High", "Medium")),
            "distinctPortSignatures": len(port_signatures),
        },
        "connectedComponents": len(comp_sizes),
        "isolatedNodes": isolated_count,
        "largestComponent": max(comp_sizes.values()) if comp_sizes else 0,
        "largestRemainingNodes": [
            {
                "id": s["id"],
                "uniqueNeighbors": s["uniqueNeighbors"],
                "linkCount": s["linkCount"],
                "weightedDegree": s["weightedDegree"],
            }
            for s in stats
            if s["id"] not in present_remove
        ][:10],
    }

    metadata = dict(data.get("metadata", {}))
    metadata.update(
        {
            "source": "raw_no_hubs",
            "total_nodes": len(out_nodes),
            "total_links": len(kept_links),
            "communities": len(comp_sizes),
            "report": report,
        }
    )
    graph_out = {
        "metadata": metadata,
        "nodes": out_nodes,
        "links": kept_links,
    }

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(graph_out, f, ensure_ascii=False, indent=1)

    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    if args.public:
        public_dir = BASE.parent / "public"
        public_name = "topology_data_core.json" if args.mode == "core" else "topology_data_no_hubs.json"
        public_path = public_dir / public_name
        public_dir.mkdir(parents=True, exist_ok=True)
        with open(public_path, "w", encoding="utf-8") as f:
            json.dump(graph_out, f, ensure_ascii=False, indent=1)
        print("Public copy: %s" % public_path)

    print()
    print("Removed nodes: %s" % (", ".join(sorted(present_remove)) if present_remove else "none"))
    print("After: %d nodes / %d links (removed %d links, dropped %d isolated nodes)" % (
        len(out_nodes), len(kept_links), removed_link_count, len(dropped_isolated)
    ))
    print("Connected components: %d (isolated nodes: %d)" % (len(comp_sizes), isolated_count))
    print("Output: %s" % output_path)
    print("Report: %s" % report_path)


if __name__ == "__main__":
    main()
