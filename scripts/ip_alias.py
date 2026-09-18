# -*- coding: utf-8 -*-
"""IP 匿名化工具：在「仓库干净」与「本机可用真实数据」之间切换。

仓库里所有代码/文档只保留匿名占位 IP（10.255.x.x）；真实 IP 存在
config/ip_alias.local.json（已被 .gitignore 忽略）。

用法：
    python scripts/ip_alias.py status       # 检查代码/文档里还残留多少真实 IP
    python scripts/ip_alias.py anonymize    # 真实 IP → 匿名占位（提交前执行）
    python scripts/ip_alias.py restore      # 匿名占位 → 真实 IP（本机跑分析脚本时用，勿提交）

restore 之后请记得在提交前跑 anonymize，或直接用 `git checkout -- <文件>` 还原。
"""
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALIAS_PATH = os.path.join(ROOT, "config", "ip_alias.local.json")

# 只处理代码与文档；真实数据文件（public/*.json、*.csv）本就是本机专用、不入库
TARGETS = [
    "docs/项目说明文档.md",
    "export_for_neo4j_versioned.py",
    "scripts/analyze_host_to_host.js",
    "scripts/analyze_raw_flows.js",
    "scripts/build_business_graph.py",
    "scripts/build_purified_data.js",
    "scripts/enhance_security_data.js",
    "scripts/enhance_security_data_v2.js",
    "scripts/enrich_single_ip.py",
    "scripts/enrichers/README.md",
    "scripts/enrichers/ip_geo.py",
    "scripts/enrichers/types.py",
    "scripts/import_full_flows.js",
    "scripts/import_raw_flows.js",
    "scripts/preprocess.py",
    "scripts/preprocess_jupyter.py",
    "scripts/preview_anomaly.js",
    "scripts/preview_enrich_compare.js",
    "scripts/preview_flow_anchor.js",
    "scripts/remove_large_nodes.py",
    "src/app/api/topology/neo4j/route.ts",
    "src/components/panels.tsx",
    "src/lib/clustering.ts",
    "tests/test_apply_enrichers.py",
    "tests/test_enrichers.py",
]


def load_mapping():
    if not os.path.exists(ALIAS_PATH):
        raise SystemExit("找不到 %s（真实↔匿名映射表）" % ALIAS_PATH)
    with open(ALIAS_PATH, encoding="utf-8") as fh:
        return json.load(fh)["mapping"]


def compile_pairs(mapping, reverse=False):
    items = [(v, k) for k, v in mapping.items()] if reverse else list(mapping.items())
    # 长 key 优先，配合 \b 边界避免前缀误伤
    return [(re.compile(r"\b" + re.escape(k) + r"\b"), v) for k, v in sorted(items, key=lambda kv: -len(kv[0]))]


def apply(pairs, label):
    changed_files = 0
    changed_hits = 0
    for rel in TARGETS:
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as fh:
            original = fh.read()
        text = original
        hits = 0
        for pattern, replacement in pairs:
            text, n = pattern.subn(replacement, text)
            hits += n
        if hits:
            with open(path, "w", encoding="utf-8", newline="") as fh:
                fh.write(text)
            changed_files += 1
            changed_hits += hits
            print("  %-46s %d 处" % (rel, hits))
    print("%s：%d 个文件 / %d 处" % (label, changed_files, changed_hits))
    return changed_hits


def status():
    mapping = load_mapping()
    real = compile_pairs(mapping)
    alias = compile_pairs(mapping, reverse=True)
    real_hits = alias_hits = 0
    for rel in TARGETS:
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        r = sum(len(p.findall(text)) for p, _ in real)
        a = sum(len(p.findall(text)) for p, _ in alias)
        if r or a:
            print("  %-46s 真实 IP %d 处 / 匿名占位 %d 处" % (rel, r, a))
        real_hits += r
        alias_hits += a
    print("\n合计：真实 IP %d 处，匿名占位 %d 处" % (real_hits, alias_hits))
    print("结论：" + ("⚠️ 存在真实 IP，提交前请执行 anonymize" if real_hits else "✅ 代码/文档中无真实 IP，可安全提交"))


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else "status"
    mapping = load_mapping()
    if command == "status":
        status()
    elif command == "anonymize":
        apply(compile_pairs(mapping), "已匿名化")
    elif command == "restore":
        apply(compile_pairs(mapping, reverse=True), "已还原为真实 IP（请勿提交）")
    else:
        raise SystemExit("未知命令：%s（可用：status / anonymize / restore）" % command)


if __name__ == "__main__":
    main()
