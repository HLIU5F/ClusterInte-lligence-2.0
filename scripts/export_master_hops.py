# -*- coding: utf-8 -*-
"""master 节点一跳/二跳详情导出（供安全域 / 流量分类使用）。

输入
  .work/master.xlsx                      —— 由 master节点IP.xls 转换而来（分组标签 + IP）
  public/topology_for_frontend_new2.0.json —— 厂内访问关系图（3358 节点 / 23741 边，带 ports/protocols）

输出
  D:\\桌面\\master节点_一跳二跳详情.xlsx
"""
import io
import json
import os
import re
import sys
from collections import Counter, defaultdict

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ROOT = r'D:\桌面\ClusterInte-lligence-2.0'
GRAPH = os.path.join(ROOT, 'public', 'topology_for_frontend_new2.0.json')
MASTER_XLSX = os.path.join(ROOT, '.work', 'master.xlsx')
OUT = r'D:\桌面\master节点_一跳二跳详情.xlsx'

IP_RE = re.compile(r'^\d{1,3}(\.\d{1,3}){3}$')

# ---------------------------------------------------------------- 读 master 清单
def read_masters():
    wb = load_workbook(MASTER_XLSX, data_only=True)
    ws = wb.worksheets[0]
    groups = []
    cur = None
    for row in ws.iter_rows(values_only=True):
        v = row[0]
        if v is None:
            continue
        s = str(v).strip()
        if not s:
            continue
        if IP_RE.match(s):
            if cur is None:
                cur = {'group': '(未分组)', 'ips': []}
                groups.append(cur)
            cur['ips'].append(s)
        else:
            cur = {'group': s, 'ips': []}
            groups.append(cur)
    return [g for g in groups if g['ips']]


# ---------------------------------------------------------------- 读图
def load_graph(path):
    with io.open(path, 'r', encoding='utf-8') as f:
        d = json.load(f)
    nodes = {n['id']: n for n in d['nodes']}
    edges = {}
    for l in d['links']:
        s = l['source']['id'] if isinstance(l['source'], dict) else l['source']
        t = l['target']['id'] if isinstance(l['target'], dict) else l['target']
        k = (s, t)
        e = edges.get(k)
        ports = [int(p) for p in (l.get('ports') or []) if str(p).isdigit()]
        protos = [str(p) for p in (l.get('protocols') or [])]
        if e is None:
            edges[k] = {
                'source': s, 'target': t,
                'ports': set(ports), 'protocols': set(protos),
                'weight': float(l.get('weight') or 0),
                'bytes': float(l.get('bytes') or 0),
                'n_raw': 1,
            }
        else:
            e['ports'].update(ports)
            e['protocols'].update(protos)
            e['weight'] += float(l.get('weight') or 0)
            e['bytes'] += float(l.get('bytes') or 0)
            e['n_raw'] += 1
    out_adj = defaultdict(list)
    in_adj = defaultdict(list)
    for (s, t), e in edges.items():
        out_adj[s].append((t, e))
        in_adj[t].append((s, e))
    return nodes, edges, out_adj, in_adj, d.get('metadata') or {}


def ports_text(ports, limit=60):
    ps = sorted(ports)
    if not ps:
        return ''
    if len(ps) > limit:
        return ','.join(str(p) for p in ps[:limit]) + ' …(+%d)' % (len(ps) - limit)
    return ','.join(str(p) for p in ps)


def node_row(n):
    if not n:
        return {'domain': '', 'zone_label': '', 'role': '', 'subnet': '', 'degree': '', 'asset': '', 'anom': ''}
    return {
        'domain': n.get('security_domain') or n.get('zone_id') or '',
        'zone_label': n.get('zone_label') or '',
        'role': n.get('role_guess') or '',
        'subnet': n.get('subnet_24') or '',
        'degree': n.get('degree') or 0,
        'asset': n.get('asset_value') if n.get('asset_value') is not None else '',
        'anom': ('是(' + str(n.get('anomaly_level'))) + ')' if n.get('is_anomaly') else '否',
    }


# ---------------------------------------------------------------- 计算
def analyse(groups, nodes, edges, out_adj, in_adj):
    masters = []          # 01 行
    hop1_node_rows = []   # 02 一跳节点（节点级去重）
    hop1_rows = []        # 03 一跳边（方向级）
    hop2_node_rows = []   # 04
    hop2_path_rows = []   # 05
    port_rows = []        # 06
    domain_rows = []      # 07

    for g in groups:
        for ip in g['ips']:
            n = nodes.get(ip)
            nr = node_row(n)
            outs = out_adj.get(ip, [])
            ins = in_adj.get(ip, [])
            neighbors = set(t for t, _ in outs) | set(s for s, _ in ins)

            # 02 一跳节点（节点级去重，标明方向与出入端口）
            for peer in sorted(neighbors):
                pn = nodes.get(peer)
                pr = node_row(pn)
                out_e = [(t, e) for t, e in outs if t == peer]
                in_e = [(s, e) for s, e in ins if s == peer]
                if out_e and in_e:
                    rel = '双向 (主↔对端)'
                elif out_e:
                    rel = '出向 (主→对端)'
                else:
                    rel = '入向 (对端→主)'
                oports = set()
                iports = set()
                protos = set()
                ow = iw = 0.0
                for _, e in out_e:
                    oports |= e['ports']
                    protos |= e['protocols']
                    ow += e['weight']
                for _, e in in_e:
                    iports |= e['ports']
                    protos |= e['protocols']
                    iw += e['weight']
                hop1_node_rows.append([
                    ip, g['group'], peer, rel,
                    ports_text(oports), ports_text(iports), ','.join(sorted(protos)),
                    int(ow), int(iw), pr['domain'], pr['zone_label'], pr['role'], pr['subnet'],
                    pr['degree'], pr['asset'],
                    '同域' if pr['domain'] == nr['domain'] else '跨域', pr['anom'],
                ])

            # 一跳边（按方向）
            for t, e in sorted(outs, key=lambda x: x[0]):
                tn = nodes.get(t)
                tr = node_row(tn)
                hop1_rows.append([
                    ip, g['group'], '出向 (主→对端)', t, tr['domain'], tr['zone_label'], tr['role'],
                    tr['subnet'], tr['degree'], tr['asset'], ','.join(sorted(e['protocols'])),
                    ports_text(e['ports']), len(e['ports']), int(e['weight']), int(e['bytes']),
                    '同域' if tr['domain'] == nr['domain'] else '跨域',
                    '是' if (t, ip) in edges else '否', tr['anom'],
                ])
            for s, e in sorted(ins, key=lambda x: x[0]):
                sn = nodes.get(s)
                sr = node_row(sn)
                hop1_rows.append([
                    ip, g['group'], '入向 (对端→主)', s, sr['domain'], sr['zone_label'], sr['role'],
                    sr['subnet'], sr['degree'], sr['asset'], ','.join(sorted(e['protocols'])),
                    ports_text(e['ports']), len(e['ports']), int(e['weight']), int(e['bytes']),
                    '同域' if sr['domain'] == nr['domain'] else '跨域',
                    '是' if (ip, s) in edges else '否', sr['anom'],
                ])

            # 二跳：以邻居为中专，收集 (far, mid, 段1, 段2)
            far_map = defaultdict(list)   # far -> [(mid, seg1, seg2, dir1, dir2)]
            for mid in neighbors:
                seg1 = edges.get((ip, mid)) or edges.get((mid, ip))
                dir1 = '主→中转' if (ip, mid) in edges else '中转→主（对端→主）'
                seg2s = []
                for x, e in out_adj.get(mid, []):
                    if x != ip:
                        seg2s.append((x, e, '中转→二跳'))
                for x, e in in_adj.get(mid, []):
                    if x != ip:
                        seg2s.append((x, e, '二跳→中转'))
                for far, seg2, dir2 in seg2s:
                    if far == ip:
                        continue
                    far_map[far].append((mid, seg1, seg2, dir1, dir2))

            new_far = {f: v for f, v in far_map.items() if f not in neighbors}

            # 03 二跳节点（按 far 去重）
            for far, items in sorted(new_far.items()):
                fn = nodes.get(far)
                fr = node_row(fn)
                mids = sorted(set(i[0] for i in items))
                ports2 = set()
                protos2 = set()
                w = 0.0
                for _, _, seg2, _, _ in items:
                    ports2 |= seg2['ports']
                    protos2 |= seg2['protocols']
                    w += seg2['weight']
                hop2_node_rows.append([
                    ip, g['group'], far, fr['domain'], fr['zone_label'], fr['role'], fr['subnet'],
                    fr['degree'], fr['asset'], len(mids),
                    ','.join(mids[:8]) + ('…(+%d)' % (len(mids) - 8) if len(mids) > 8 else ''),
                    ports_text(ports2), ','.join(sorted(protos2)), int(w),
                    '是' if far in neighbors else '否',
                ])
                # 04 路径
                for mid, seg1, seg2, dir1, dir2 in items[:12]:
                    hop2_path_rows.append([
                        ip, g['group'], mid, far, dir1 + ' ⇒ ' + dir2,
                        ports_text(seg1['ports']) if seg1 else '', ','.join(sorted(seg1['protocols'])) if seg1 else '',
                        ports_text(seg2['ports']), ','.join(sorted(seg2['protocols'])),
                        node_row(nodes.get(far))['domain'],
                        '是' if (ip, far) in edges or (far, ip) in edges else '否',
                    ])

            # 05 端口画像（一跳，按方向）
            for direction, items in (('出向 (主→对端)', outs), ('入向 (对端→主)', ins)):
                per_port = defaultdict(lambda: {'edges': 0, 'nbrs': set(), 'dom': set(), 'proto': set(), 'w': 0.0})
                for peer, e in items:
                    for p in (e['ports'] or {0}):
                        d = per_port[p]
                        d['edges'] += 1
                        d['nbrs'].add(peer)
                        d['dom'].add(node_row(nodes.get(peer))['domain'])
                        d['proto'] |= e['protocols']
                        d['w'] += e['weight']
                for p in sorted(per_port):
                    d = per_port[p]
                    port_rows.append([
                        ip, g['group'], direction, p, ','.join(sorted(d['proto'])),
                        d['edges'], len(d['nbrs']), ','.join(sorted(x for x in d['dom'] if x)), int(d['w']),
                    ])

            # 06 域间对流（一跳，按方向 × 对端域 × 对端角色）
            for direction, items in (('出向 (主→对端)', outs), ('入向 (对端→主)', ins)):
                per_dom = defaultdict(lambda: {'edges': 0, 'nbrs': set(), 'ports': set(), 'w': 0.0})
                for peer, e in items:
                    pr = node_row(nodes.get(peer))
                    k = (pr['domain'], pr['role'])
                    d = per_dom[k]
                    d['edges'] += 1
                    d['nbrs'].add(peer)
                    d['ports'] |= e['ports']
                    d['w'] += e['weight']
                for (dom, role), d in sorted(per_dom.items()):
                    domain_rows.append([
                        ip, g['group'], direction, dom, role, d['edges'], len(d['nbrs']),
                        len(d['ports']), ports_text(d['ports'], 25), int(d['w']),
                    ])

            dom1 = set(node_row(nodes.get(t))['domain'] for t in neighbors)
            dom2 = set(r[3] for r in hop2_node_rows if r[0] == ip)
            allports = set()
            for _, e in outs:
                allports |= e['ports']
            for _, e in ins:
                allports |= e['ports']
            masters.append([
                len(masters) + 1, g['group'], ip, '是' if n else '否',
                nr['domain'], nr['zone_label'], nr['subnet'], nr['role'], nr['asset'],
                n.get('degree') if n else 0, n.get('in_degree') if n else 0, n.get('out_degree') if n else 0,
                n.get('community') if n else '', nr['anom'],
                len(neighbors), len(outs), len(ins), len(new_far),
                len(neighbors) + len(new_far), len(dom1 - {''}), len(dom2 - {''}), len(allports),
            ])

    return masters, hop1_node_rows, hop1_rows, hop2_node_rows, hop2_path_rows, port_rows, domain_rows


def group_summary(groups, masters, hop2_node_rows):
    rows = []
    for g in groups:
        ips = set(g['ips'])
        h1 = set()
        h2 = set()
        ports = set()
        doms = Counter()
        edges = 0
        for r in hop2_node_rows:
            if r[0] in ips:
                h2.add(r[2])
                doms[r[3]] += 1
        for r in masters:
            if r[1] == g['group']:
                h1 |= set()
        # 1 跳节点并集在 master 明细里没有存节点清单，改用 group 内主节点互连推导不做，直接留空计数
        rows.append([g['group'], len(g['ips']), '', len(h2), '', '', ','.join(
            '%s:%d' % (k, v) for k, v in doms.most_common())])
    return rows


# ---------------------------------------------------------------- 写 Excel
HDR_FILL = PatternFill('solid', fgColor='1F3864')
HDR_FONT = Font(color='FFFFFF', bold=True, size=10)
THIN = Side(style='thin', color='D9D9D9')
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)


def write_sheet(wb, title, headers, rows, widths=None, freeze='A2'):
    ws = wb.create_sheet(title)
    ws.append(headers)
    for c in range(1, len(headers) + 1):
        cell = ws.cell(row=1, column=c)
        cell.fill = HDR_FILL
        cell.font = HDR_FONT
        cell.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
    for r in rows:
        ws.append(r)
    ws.row_dimensions[1].height = 30
    if widths:
        for i, w in enumerate(widths, start=1):
            ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = freeze
    if rows:
        ws.auto_filter.ref = 'A1:%s%d' % (get_column_letter(len(headers)), len(rows) + 1)
    for row in ws.iter_rows(min_row=1, max_row=min(len(rows) + 1, 4000)):
        for cell in row:
            cell.border = BORDER
            if cell.row > 1:
                cell.font = Font(size=9)
    return ws


def main():
    groups = read_masters()
    nodes, edges, out_adj, in_adj, meta = load_graph(GRAPH)
    masters, hop1_node_rows, hop1_rows, hop2_node_rows, hop2_path_rows, port_rows, domain_rows = analyse(
        groups, nodes, edges, out_adj, in_adj)

    wb = Workbook()
    wb.remove(wb.active)

    # 00 说明
    n_master = sum(len(g['ips']) for g in groups)
    total_bytes = sum(e['bytes'] for e in edges.values())
    info = [
        ['项目', '内容'],
        ['生成时间', __import__('datetime').datetime.now().strftime('%Y-%m-%d %H:%M:%S')],
        ['master 清单来源', r'master节点IP.xls（4 个分组，共 %d 个 IP）' % n_master],
        ['访问关系图来源', 'public/topology_for_frontend_new2.0.json'],
        ['图规模', '%d 节点 / %d 条有向边（同向重复边合并后 %d 条）' % (
            len(nodes), len(json.load(io.open(GRAPH, encoding='utf-8'))['links']), len(edges))],
        ['图元数据', 'source=%s, generated_at=%s' % (meta.get('source', ''), meta.get('generated_at', ''))],
        ['一跳定义', '与 master 直接存在访问关系（出向或入向）的节点，去重后计 1 个节点；出/入分别统计边'],
        ['二跳定义', '从 master 出发、经 1 个中转节点可达、且最短距离恰为 2 的节点（已排除 master 自身与全部 1 跳节点）'],
        ['方向说明', '出向 = master 作为源发起访问（master → 对端）；入向 = 对端发起访问 master（对端 → master）'],
        ['端口说明', 'ports 为该访问关系（边）上出现过的服务端口（目的端口），protocols 为协议'],
        ['权重说明', 'weight 为数据源自带的会话/记录权重；bytes 在当前数据集中测得合计 %d，若为 0 表示源数据未提供字节数' % int(total_bytes)],
        ['安全域字段', 'security_domain / zone_label 来自图中节点属性（Internal/DMZ/App/DB/External/Management 三层安全域）'],
        ['资产价值', 'asset_value 为图内预计算资产价值（0-100），越高越核心'],
        ['用途提示', '按 (方向, 对端安全域, 对端角色, 端口) 四元组即可切出流量分类规则，见 06/07 两张聚合表'],
        ['表格说明', '02 是把 03 按节点去重后的清单（每个对端只出现一次，标注双向/单向与出入端口），03 是逐条有向边'],
        ['表格截断说明', '04 表的「中转示例」最多列 8 个中转节点；05 表每个 (主节点, 二跳节点) 组合最多列 12 条中转路径，其余已省略但不影响 04 的去重计数'],
        ['注意事项', '二跳只代表拓扑可达，不代表真实会话；跨域二跳建议结合 07 表的方向与端口再做判定'],
    ]
    ws = wb.create_sheet('00_说明')
    for r in info:
        ws.append(r)
    for c in range(1, 3):
        cell = ws.cell(row=1, column=c)
        cell.fill = HDR_FILL
        cell.font = HDR_FONT
    ws.column_dimensions['A'].width = 18
    ws.column_dimensions['B'].width = 120
    for row in ws.iter_rows(min_row=2):
        for cell in row:
            cell.alignment = Alignment(vertical='top', wrap_text=True)
            cell.font = Font(size=10)

    write_sheet(wb, '01_主节点清单',
                ['序号', '分组', '主节点IP', '是否在图中', '安全域', '域名称', '子网/24', '角色', '资产价值',
                 '度数', '入度', '出度', '社区', '异常', '一跳节点数', '一跳出向边', '一跳入向边',
                 '二跳新增节点', '二跳节点合计', '一跳覆盖域数', '二跳覆盖域数', '涉及端口数'],
                masters,
                [6, 8, 15, 10, 11, 16, 12, 9, 9, 7, 7, 7, 7, 10, 11, 11, 11, 12, 12, 11, 11, 10])

    write_sheet(wb, '02_一跳节点清单',
                ['主节点', '分组', '一跳节点', '关系方向', '出向端口(主→对端)', '入向端口(对端→主)',
                 '协议', '出向会话', '入向会话', '安全域', '域名称', '角色', '子网/24',
                 '度数', '资产价值', '同域/跨域', '异常'],
                hop1_node_rows,
                [15, 8, 15, 18, 30, 30, 10, 10, 10, 11, 16, 9, 12, 7, 9, 11, 8])

    write_sheet(wb, '03_一跳边明细',
                ['主节点', '分组', '方向', '对端IP', '对端安全域', '对端域名称', '对端角色', '对端子网/24',
                 '对端度数', '对端资产价值', '协议', '端口', '端口数', '会话权重', '字节',
                 '同域/跨域', '是否双向', '对端异常'],
                hop1_rows,
                [15, 8, 17, 15, 11, 16, 9, 12, 9, 10, 10, 34, 7, 10, 9, 11, 9, 9])

    write_sheet(wb, '04_二跳节点明细',
                ['主节点', '分组', '二跳节点', '安全域', '域名称', '角色', '子网/24', '度数', '资产价值',
                 '中转节点数', '中转示例', '经中转的端口', '协议', '会话权重合计', '是否同时是1跳'],
                hop2_node_rows,
                [15, 8, 15, 11, 16, 9, 12, 7, 9, 10, 44, 30, 10, 12, 12])

    if hop2_path_rows:
        write_sheet(wb, '05_二跳路径明细',
                    ['主节点', '分组', '一跳中转', '二跳节点', '路径方向', '段1端口', '段1协议',
                     '段2端口', '段2协议', '二跳安全域', '是否与主直达'],
                    hop2_path_rows,
                    [15, 8, 15, 15, 26, 26, 9, 26, 9, 11, 11])

    write_sheet(wb, '06_端口画像',
                ['主节点', '分组', '方向', '端口', '协议', '边数', '对端节点数', '对端安全域', '会话权重'],
                port_rows, [15, 8, 17, 9, 10, 7, 11, 24, 10])

    write_sheet(wb, '07_域间对流',
                ['主节点', '分组', '方向', '对端安全域', '对端角色', '边数', '对端节点数', '端口数', '端口(top25)', '会话权重'],
                domain_rows, [15, 8, 17, 13, 10, 7, 11, 8, 40, 10])

    # 08 汇总（按分组）
    summ = []
    for g in groups:
        ips = set(g['ips'])
        h2 = Counter()
        doms = Counter()
        for r in hop2_node_rows:
            if r[0] in ips:
                h2[r[2]] += 1
                doms[r[3]] += 1
        tot_edges = sum(r[15] + r[16] for r in masters if r[1] == g['group'])
        tot_h1 = sum(r[14] for r in masters if r[1] == g['group'])
        summ.append([g['group'], len(g['ips']), tot_h1, len(h2), tot_edges,
                     ' | '.join('%s:%d' % (k, v) for k, v in doms.most_common())])
    write_sheet(wb, '08_分组汇总',
                ['分组', 'master 数', '一跳节点合计(含重复)', '二跳节点并集', '一跳边数', '二跳安全域分布'],
                summ, [10, 12, 22, 18, 12, 70])

    wb.save(OUT)

    print(json.dumps({
        'out': OUT,
        'masters': len(masters),
        'hop1_node_rows': len(hop1_node_rows),
        'hop1_edge_rows': len(hop1_rows),
        'hop2_node_rows': len(hop2_node_rows),
        'hop2_path_rows': len(hop2_path_rows),
        'port_rows': len(port_rows),
        'domain_rows': len(domain_rows),
        'edges_merged': len(edges),
        'bytes_total': int(total_bytes),
        'hop1_per_master': {r[2]: r[14] for r in masters},
        'hop2_per_master': {r[2]: r[17] for r in masters},
    }, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
