# -*- coding: utf-8 -*-
"""生成交付给 leader 的「master 节点一跳关系」材料。

输出
  D:\\桌面\\master节点一跳关系_交付版.xlsx   （结论 + 总览 + 一跳清单 + 端口/域聚合 + 图表）
  D:\\桌面\\master节点分析摘要.docx          （2 页：结论、总览表、特征、用法、口径）
"""
import io
import json
import os
from collections import Counter, defaultdict
from datetime import datetime

from openpyxl import Workbook, load_workbook
from openpyxl.chart import BarChart, Reference
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.formatting.rule import DataBarRule

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import parse_xml
from docx.oxml.ns import nsdecls, qn
from docx.shared import Cm, Pt, RGBColor

ROOT = r'D:\桌面\ClusterInte-lligence-2.0'
GRAPH = os.path.join(ROOT, 'public', 'topology_for_frontend_new2.0.json')
MASTER_XLSX = os.path.join(ROOT, '.work', 'master.xlsx')
OUT_XLSX = r'D:\桌面\master节点一跳关系_交付版.xlsx'
OUT_DOCX = r'D:\桌面\master节点分析摘要_交付版.docx'

DOMAINS = ['DMZ', 'Internal', 'App', 'DB', 'External', 'Management']
DOMAIN_CN = {
    'DMZ': '互联网接入区', 'Internal': '内部通用区', 'App': '应用逻辑区',
    'DB': '数据库核心区', 'External': '外网/第三方', 'Management': '运维管理区',
}
IP_RE = __import__('re').compile(r'^\d{1,3}(\.\d{1,3}){3}$')


# ------------------------------------------------------------------ 数据
def read_masters():
    wb = load_workbook(MASTER_XLSX, data_only=True)
    ws = wb.worksheets[0]
    groups, cur = [], None
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
            if s not in cur['ips']:
                cur['ips'].append(s)
        else:
            cur = {'group': s, 'ips': []}
            groups.append(cur)
    return [g for g in groups if g['ips']]


def load_graph(path):
    with io.open(path, 'r', encoding='utf-8') as f:
        d = json.load(f)
    nodes = {n['id']: n for n in d['nodes']}
    edges = {}
    for l in d['links']:
        s = l['source']['id'] if isinstance(l['source'], dict) else l['source']
        t = l['target']['id'] if isinstance(l['target'], dict) else l['target']
        k = (s, t)
        ports = set(int(p) for p in (l.get('ports') or []) if str(p).isdigit())
        e = edges.get(k)
        if e is None:
            edges[k] = {'ports': ports, 'protocols': set(l.get('protocols') or []),
                        'weight': float(l.get('weight') or 0)}
        else:
            e['ports'] |= ports
            e['protocols'] |= set(l.get('protocols') or [])
            e['weight'] += float(l.get('weight') or 0)
    out_adj, in_adj = defaultdict(list), defaultdict(list)
    for (s, t), e in edges.items():
        out_adj[s].append((t, e))
        in_adj[t].append((s, e))
    return nodes, edges, out_adj, in_adj, d.get('metadata') or {}


def dom(n):
    if not n:
        return ''
    return n.get('security_domain') or n.get('zone_id') or ''


def ptext(ports, limit=8):
    ps = sorted(p for p in ports if p)
    if not ps:
        return ''
    return ','.join(str(p) for p in ps[:limit]) + ('…' if len(ps) > limit else '')


# ------------------------------------------------------------------ 计算
def compute(groups, nodes, edges, out_adj, in_adj):
    per = {}
    hop1_rows = []
    port_rows = []
    domain_rows = []
    for g in groups:
        for ip in g['ips']:
            n = nodes.get(ip) or {}
            outs, ins = out_adj.get(ip, []), in_adj.get(ip, [])
            nbrs = sorted(set(t for t, _ in outs) | set(s for s, _ in ins))
            dcount, same, cross, bi = Counter(), 0, 0, 0
            for p in nbrs:
                dp = dom(nodes.get(p))
                dcount[dp] += 1
                if dp == dom(n):
                    same += 1
                else:
                    cross += 1
                if (ip, p) in edges and (p, ip) in edges:
                    bi += 1
            # 一跳明细行
            for p in nbrs:
                oe = [e for t, e in outs if t == p]
                ie = [e for s, e in ins if s == p]
                rel = '双向' if (oe and ie) else ('主→对端' if oe else '对端→主')
                ports = set()
                w = 0.0
                protos = set()
                for e in oe + ie:
                    ports |= e['ports']
                    protos |= e['protocols']
                    w += e['weight']
                pn = nodes.get(p) or {}
                hop1_rows.append([
                    ip, g['group'], p, rel, ptext(ports), ','.join(sorted(protos)),
                    int(w), dom(pn), DOMAIN_CN.get(dom(pn), ''),
                    pn.get('role_guess') or '', pn.get('asset_value') if pn.get('asset_value') is not None else '',
                    pn.get('degree') or 0, '同域' if dom(pn) == dom(n) else '跨域',
                    '是' if (ip, p) in edges and (p, ip) in edges else '否',
                    '是' if pn.get('is_anomaly') else '否',
                ])
            # 端口 × 方向
            for direction, items in (('出向', outs), ('入向', ins)):
                ports = defaultdict(lambda: {'edges': 0, 'peers': set(), 'doms': set()})
                for p, e in items:
                    for port in (e['ports'] or {0}):
                        ports[port]['edges'] += 1
                        ports[port]['peers'].add(p)
                        ports[port]['doms'].add(dom(nodes.get(p)))
                for port in sorted(ports):
                    r = ports[port]
                    port_rows.append([ip, g['group'], direction, port, r['edges'],
                                      len(r['peers']), ','.join(sorted(x for x in r['doms'] if x))])
            # 域 × 方向
            for direction, items in (('出向', outs), ('入向', ins)):
                dm = defaultdict(lambda: {'edges': 0, 'peers': set(), 'ports': set()})
                for p, e in items:
                    k = dom(nodes.get(p))
                    dm[k]['edges'] += 1
                    dm[k]['peers'].add(p)
                    dm[k]['ports'] |= e['ports']
                for k in [d for d in DOMAINS if d in dm] + [d for d in dm if d not in DOMAINS]:
                    r = dm[k]
                    domain_rows.append([ip, g['group'], direction, k, DOMAIN_CN.get(k, ''),
                                        r['edges'], len(r['peers']), len(r['ports']), ptext(r['ports'], 10)])
            # 二跳
            far = set()
            for m in nbrs:
                far |= set(t for t, _ in out_adj.get(m, [])) | set(s for s, _ in in_adj.get(m, []))
            far -= set(nbrs)
            far.discard(ip)
            fdom = Counter(dom(nodes.get(f)) for f in far)
            per[ip] = {
                'group': g['group'], 'zone': dom(n), 'zone_cn': DOMAIN_CN.get(dom(n), ''),
                'role': n.get('role_guess') or '', 'asset': n.get('asset_value'),
                'degree': n.get('degree') or 0, 'indeg': n.get('in_degree') or 0,
                'outdeg': n.get('out_degree') or 0,
                'h1': len(nbrs), 'out': len(outs), 'in': len(ins),
                'same': same, 'cross': cross, 'bi': bi, 'h2': len(far),
                'domains': {d: dcount.get(d, 0) for d in DOMAINS if dcount.get(d, 0)},
                'h2dom': {d: fdom.get(d, 0) for d in DOMAINS if fdom.get(d, 0)},
                'top_ports': Counter(),
                'anomaly_nbrs': sum(1 for p in nbrs if (nodes.get(p) or {}).get('is_anomaly')),
            }
            for p, e in outs + ins:
                for port in (e['ports'] or {0}):
                    per[ip]['top_ports'][port] += 1
    # 一跳明细排序：按分组 → 主节点 → 权重降序
    order = {}
    for g in groups:
        for ip in g['ips']:
            order[ip] = (g['group'], ip)
    hop1_rows.sort(key=lambda r: (order.get(r[0], ('', r[0])), -r[6], r[2]))
    return per, hop1_rows, port_rows, domain_rows


# ------------------------------------------------------------------ Excel 样式
HDR = PatternFill('solid', fgColor='1F3864')
HDR_F = Font(color='FFFFFF', bold=True, size=10)
SUB = PatternFill('solid', fgColor='D9E2F3')
THIN = Side(style='thin', color='BFBFBF')
BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)


def sheet_head(ws, headers, widths, row=1):
    for i, h in enumerate(headers, start=1):
        c = ws.cell(row=row, column=i, value=h)
        c.fill = HDR
        c.font = HDR_F
        c.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
    ws.row_dimensions[row].height = 32
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = 'A%d' % (row + 1)


def body(ws, rows, start=2, size=9):
    for r in rows:
        ws.append(r)
    for row in ws.iter_rows(min_row=start, max_row=start + len(rows) - 1):
        for c in row:
            c.border = BOX
            c.font = Font(size=size)
            c.alignment = Alignment(vertical='center')


# ------------------------------------------------------------------ Excel
def build_xlsx(groups, masters, per, hop1_rows, port_rows, domain_rows, meta):
    wb = Workbook()
    wb.remove(wb.active)
    n_master = sum(len(g['ips']) for g in groups)
    total_h1 = sum(v['h1'] for v in per.values())
    total_edges = sum(v['out'] + v['in'] for v in per.values())
    total_h2 = sum(v['h2'] for v in per.values())
    cross_all = sum(v['cross'] for v in per.values())
    same_all = sum(v['same'] for v in per.values())
    bi_all = sum(v['bi'] for v in per.values())
    port_counter = Counter()
    for v in per.values():
        for p, c in v['top_ports'].items():
            port_counter[p] += c
    top5 = port_counter.most_common(5)
    top5_share = sum(c for _, c in top5) / max(sum(port_counter.values()), 1)
    edge_total = len(hop1_rows)

    # ---------- 00 结论
    ws0 = wb.create_sheet('00_结论与口径')
    ws0.column_dimensions['A'].width = 4
    ws0.column_dimensions['B'].width = 26
    ws0.column_dimensions['C'].width = 96
    t = ws0.cell(row=1, column=2, value='Master 节点一跳访问关系梳理')
    t.font = Font(bold=True, size=16, color='1F3864')
    ws0.merge_cells('B1:C1')
    s = ws0.cell(row=2, column=2, value='数据来源：master节点IP.xls（%d 个分组 / %d 个 master）· 访问关系图 topology_for_frontend_new2.0.json（%d 节点 / %d 边）· 生成于 %s'
                 % (len(groups), n_master, 3358, 23741, datetime.now().strftime('%Y-%m-%d %H:%M')))
    s.font = Font(size=9, color='595959')
    ws0.merge_cells('B2:C2')

    r = 4
    ws0.cell(row=r, column=2, value='一句话结论').font = Font(bold=True, size=11, color='1F3864')
    r += 1
    summary = ('%d 个 master 与 %d 个节点存在直接访问关系（去重后 %d 条有向边），'
               '其中 %.0f%% 是跨安全域访问，说明 master 是横向枢纽而非域内普通主机；'
               '一跳端口高度集中在前 5 个（%s，合计占 %.0f%%），可以直接作为流量分类的第一层特征。'
               % (n_master, total_h1, total_edges, cross_all / max(cross_all + same_all, 1) * 100,
                  '/'.join(str(p) for p, _ in top5), top5_share * 100))
    c = ws0.cell(row=r, column=2, value=summary)
    c.alignment = Alignment(wrap_text=True, vertical='top')
    c.font = Font(size=10)
    ws0.merge_cells(start_row=r, start_column=2, end_row=r, end_column=3)
    ws0.row_dimensions[r].height = 58

    r += 2
    ws0.cell(row=r, column=2, value='关键数字').font = Font(bold=True, size=11, color='1F3864')
    r += 1
    facts = [
        ('master 数量', '%d 个，分 %d 组：%s' % (n_master, len(groups),
                                            '、'.join('%s %d 个' % (g['group'], len(g['ips'])) for g in groups))),
        ('一跳关系', '%d 个不同节点 / %d 条有向边（出向 %d、入向 %d）'
         % (total_h1, total_edges, sum(v['out'] for v in per.values()), sum(v['in'] for v in per.values()))),
        ('同域 vs 跨域', '同域 %d（%.0f%%）· 跨域 %d（%.0f%%）'
         % (same_all, same_all / max(same_all + cross_all, 1) * 100,
            cross_all, cross_all / max(same_all + cross_all, 1) * 100)),
        ('双向关系', '%d 个，占一跳节点的 %.0f%%（双向一般意味着既能发起也能被访问，是控制策略要重点看的）'
         % (bi_all, bi_all / max(total_h1, 1) * 100)),
        ('一跳规模区间', '最多 %s（%d 个）、最少 %s（%d 个）'
         % (max(per, key=lambda k: per[k]['h1']), max(v['h1'] for v in per.values()),
            min(per, key=lambda k: per[k]['h1']), min(v['h1'] for v in per.values()))),
        ('二跳触达', '合计 %d 个（按 master×节点 去重），最多 %d、最少 %d —— 仅代表拓扑可达，不等同真实会话'
         % (total_h2, max(v['h2'] for v in per.values()), min(v['h2'] for v in per.values()))),
        ('Top5 端口', '、'.join('%d（%d 条边）' % (p, c) for p, c in top5) + '，合计占 %.0f%%' % (top5_share * 100)),
    ]
    for k, v in facts:
        ws0.cell(row=r, column=2, value=k).font = Font(size=10, bold=True)
        c = ws0.cell(row=r, column=3, value=v)
        c.alignment = Alignment(wrap_text=True, vertical='top')
        c.font = Font(size=10)
        r += 1

    r += 1
    ws0.cell(row=r, column=2, value='口径与限制').font = Font(bold=True, size=11, color='1F3864')
    r += 1
    notes = [
        ('一跳定义', '与 master 直接存在访问关系的节点，按节点去重；出向 = master 发起，入向 = 对端发起'),
        ('一跳边数', '同一个对端存在双向关系时计 2 条边，所以边数 ≥ 节点数'),
        ('端口含义', '该访问关系上出现过的服务端口（目的端口）；数据源未提供字节数，weight 为会话/记录权重'),
        ('安全域', '取自图中节点属性 security_domain（DMZ/Internal/App/DB/External/Management 三层域）'),
        ('二跳', '最短距离恰为 2 的节点，已排除 master 自身与全部一跳节点；只用于评估暴露面，不代表允许访问'),
        ('建议用法', '流量分类以 (方向, 对端安全域, 端口) 三元组落规则，见 03/04 两张聚合表'),
    ]
    for k, v in notes:
        ws0.cell(row=r, column=2, value=k).font = Font(size=9, bold=True, color='404040')
        c = ws0.cell(row=r, column=3, value=v)
        c.alignment = Alignment(wrap_text=True, vertical='top')
        c.font = Font(size=9, color='404040')
        r += 1

    # ---------- 01 总览
    ws1 = wb.create_sheet('01_Master总览')
    heads = ['序号', '分组', 'master IP', '安全域', '域名称', '角色', '资产价值',
             '总度数', '入度', '出度', '一跳节点数', '出向边', '入向边',
             '同域', '跨域', '跨域占比', '双向', '二跳节点数', 'Top5 端口']
    sheet_head(ws1, heads, [6, 8, 16, 11, 16, 9, 9, 8, 6, 6, 11, 8, 8, 7, 7, 10, 7, 11, 34])
    rows = []
    for i, ip in enumerate(sorted(per, key=lambda k: (per[k]['group'], k)), start=1):
        v = per[ip]
        rows.append([i, v['group'], ip, v['zone'], v['zone_cn'], v['role'],
                     v['asset'], v['degree'], v['indeg'], v['outdeg'],
                     v['h1'], v['out'], v['in'], v['same'], v['cross'],
                     round(v['cross'] / max(v['h1'], 1), 3), v['bi'], v['h2'],
                     ','.join(str(p) for p, _ in v['top_ports'].most_common(5))])
    body(ws1, rows)
    for row in ws1.iter_rows(min_row=2, max_row=1 + len(rows), min_col=16, max_col=16):
        for c in row:
            c.number_format = '0%'
    ws1.auto_filter.ref = 'A1:S%d' % (1 + len(rows))
    ws1.conditional_formatting.add('K2:K%d' % (1 + len(rows)),
                                   DataBarRule(start_type='min', end_type='max', color='5B9BD5'))
    ws1.conditional_formatting.add('R2:R%d' % (1 + len(rows)),
                                   DataBarRule(start_type='min', end_type='max', color='ED7D31'))

    # 域分布矩阵（图表数据源，放最后当附录）
    ws6 = wb.create_sheet('附_域分布矩阵')
    sheet_head(ws6, ['master IP'] + DOMAINS,
               [16] + [11] * len(DOMAINS))
    mrows = []
    for ip in sorted(per, key=lambda k: (per[k]['group'], k)):
        mrows.append([ip] + [per[ip]['domains'].get(d, 0) for d in DOMAINS])
    body(ws6, mrows)

    # 图 1：一跳节点数
    ch1 = BarChart()
    ch1.type = 'bar'
    ch1.title = '每个 master 的一跳节点数'
    ch1.y_axis.title = '一跳节点数'
    ch1.height = 11
    ch1.width = 20
    data = Reference(ws1, min_col=11, min_row=1, max_row=1 + len(rows))
    cats = Reference(ws1, min_col=3, min_row=2, max_row=1 + len(rows))
    ch1.add_data(data, titles_from_data=True)
    ch1.set_categories(cats)
    ch1.legend = None
    # 图表放在表格右侧（表格到 S 列），避免盖住数据列
    ws1.add_chart(ch1, 'U2')

    # 图 2：一跳对端安全域分布（堆叠）
    ch2 = BarChart()
    ch2.type = 'bar'
    ch2.grouping = 'stacked'
    ch2.overlap = 100
    ch2.title = '一跳对端的安全域构成'
    ch2.height = 11
    ch2.width = 20
    d2 = Reference(ws6, min_col=2, max_col=1 + len(DOMAINS), min_row=1, max_row=1 + len(mrows))
    c2 = Reference(ws6, min_col=1, min_row=2, max_row=1 + len(mrows))
    ch2.add_data(d2, titles_from_data=True)
    ch2.set_categories(c2)
    ws1.add_chart(ch2, 'U28')

    # ---------- 02 一跳清单
    ws2 = wb.create_sheet('02_一跳节点清单')
    heads = ['master IP', '分组', '一跳节点', '关系方向', '端口', '协议', '会话权重',
             '安全域', '域名称', '角色', '资产价值', '对端度数', '同域/跨域', '是否双向', '异常']
    sheet_head(ws2, heads, [16, 8, 16, 10, 30, 9, 10, 11, 16, 9, 9, 9, 10, 9, 7])
    body(ws2, hop1_rows)
    ws2.auto_filter.ref = 'A1:O%d' % (1 + len(hop1_rows))

    # ---------- 03 端口分布
    ws3 = wb.create_sheet('03_端口分布')
    heads = ['master IP', '分组', '方向', '端口', '边数', '对端节点数', '对端安全域']
    sheet_head(ws3, heads, [16, 8, 8, 9, 8, 12, 26])
    body(ws3, port_rows)
    ws3.auto_filter.ref = 'A1:G%d' % (1 + len(port_rows))

    # ---------- 04 域间流向
    ws4 = wb.create_sheet('04_安全域流向')
    heads = ['master IP', '分组', '方向', '对端安全域', '域名称', '边数', '对端节点数', '端口数', '端口示例']
    sheet_head(ws4, heads, [16, 8, 8, 13, 16, 8, 12, 9, 34])
    body(ws4, domain_rows)
    ws4.auto_filter.ref = 'A1:I%d' % (1 + len(domain_rows))

    # ---------- 05 二跳概览
    ws5 = wb.create_sheet('05_二跳概览')
    heads = ['master IP', '分组', '二跳节点数'] + ['二跳-%s' % d for d in DOMAINS]
    sheet_head(ws5, heads, [16, 8, 12] + [12] * len(DOMAINS))
    r5 = []
    for ip in sorted(per, key=lambda k: (per[k]['group'], k)):
        v = per[ip]
        r5.append([ip, v['group'], v['h2']] + [v['h2dom'].get(d, 0) for d in DOMAINS])
    body(ws5, r5)

    # 固定工作表顺序：附录放最后
    order = ['00_结论与口径', '01_Master总览', '02_一跳节点清单', '03_端口分布',
             '04_安全域流向', '05_二跳概览', '附_域分布矩阵']
    wb._sheets = [wb[n] for n in order if n in wb.sheetnames]

    wb.save(OUT_XLSX)
    return {
        'n_master': n_master, 'groups': len(groups), 'total_h1': total_h1,
        'total_edges': total_edges, 'total_h2': total_h2,
        'cross_pct': cross_all / max(cross_all + same_all, 1) * 100,
        'bi': bi_all, 'bi_pct': bi_all / max(total_h1, 1) * 100,
        'top5': top5, 'top5_share': top5_share * 100,
        'hop1_rows': len(hop1_rows), 'port_rows': len(port_rows), 'domain_rows': len(domain_rows),
        'per': per, 'meta': meta,
    }


# ------------------------------------------------------------------ Word
def set_cn_font(run, name='微软雅黑', size=None, bold=None, color=None):
    run.font.name = name
    run._element.rPr.rFonts.set(qn('w:eastAsia'), name)
    if size:
        run.font.size = Pt(size)
    if bold is not None:
        run.font.bold = bold
    if color:
        run.font.color.rgb = RGBColor(*color)


def build_docx(stats, groups):
    per = stats['per']
    doc = Document()

    sec = doc.sections[0]
    sec.page_width, sec.page_height = Cm(21), Cm(29.7)
    sec.top_margin = sec.bottom_margin = Cm(2)
    sec.left_margin = sec.right_margin = Cm(2.2)

    normal = doc.styles['Normal']
    normal.font.name = '微软雅黑'
    normal.font.size = Pt(10.5)
    normal.element.rPr.rFonts.set(qn('w:eastAsia'), '微软雅黑')
    normal.paragraph_format.line_spacing = 1.25
    normal.paragraph_format.space_after = Pt(3)

    h = doc.add_paragraph()
    h.paragraph_format.space_after = Pt(2)
    set_cn_font(h.add_run('核心 Master 节点访问关系梳理'), size=19, bold=True, color=(0x1F, 0x38, 0x64))
    sub = doc.add_paragraph()
    set_cn_font(sub.add_run('数据来源：master节点IP.xls · 访问关系图 topology_for_frontend_new2.0.json · %s'
                            % datetime.now().strftime('%Y-%m-%d')), size=9, color=(0x59, 0x59, 0x59))

    # 一、结论
    doc.add_paragraph().add_run('')
    p = doc.add_paragraph()
    set_cn_font(p.add_run('一、结论摘要'), size=13, bold=True, color=(0x1F, 0x38, 0x64))

    bullets = [
        'master 共 %d 个，分布在 %d 个分组（%s）。'
        % (stats['n_master'], stats['groups'],
           '、'.join('%s %d 个' % (g['group'], len(g['ips'])) for g in groups)),
        '与 master 存在直接访问关系的节点共 %d 个、有向边 %d 条；平均每个 master 接触 %.1f 个节点，最多 %d 个（%s），最少 %d 个（%s）。'
        % (stats['total_h1'], stats['total_edges'], stats['total_h1'] / stats['n_master'],
           max(v['h1'] for v in per.values()), max(per, key=lambda k: per[k]['h1']),
           min(v['h1'] for v in per.values()), min(per, key=lambda k: per[k]['h1'])),
        '跨域访问占 %.0f%% —— master 的访问面主要在别的安全域，因此不能按"域内普通主机"处理，应按边界枢纽设规则。'
        % stats['cross_pct'],
        '一跳端口集中度很高：Top5 端口为 %s，合计占全部访问关系的 %.0f%%，适合直接作为流量分类的第一层特征。'
        % ('、'.join(str(p) for p, _ in stats['top5']), stats['top5_share']),
        '双向关系 %d 个（占 %.0f%%）：这类节点既能被 master 访问、也会主动访问 master，控制策略要双向写。'
        % (stats['bi'], stats['bi_pct']),
    ]
    for b in bullets:
        para = doc.add_paragraph(style='List Bullet')
        set_cn_font(para.add_run(b), size=10.5)

    # 二、总览表
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(8)
    set_cn_font(p.add_run('二、Master 节点总览'), size=13, bold=True, color=(0x1F, 0x38, 0x64))

    cols = ['分组', 'master IP', '安全域', '角色', '一跳', '跨域占比', '二跳', 'Top3 端口']
    # 总宽必须留在正文区（16.6cm）以内：超宽会把整块版面顶宽，正文右边缘被页面切掉
    widths = [Cm(1.3), Cm(2.8), Cm(1.3), Cm(1.6), Cm(1.0), Cm(1.8), Cm(1.1), Cm(3.2)]
    table = doc.add_table(rows=1, cols=len(cols))
    table.style = 'Table Grid'
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    tblPr = table._tbl.tblPr
    tblPr.append(parse_xml(r'<w:tblLayout %s w:type="fixed"/>' % nsdecls('w')))
    tblPr.append(parse_xml(r'<w:tblW %s w:type="dxa" w:w="%d"/>' % (nsdecls('w'), 8000)))
    for i, w in enumerate(widths):
        table.columns[i].width = w
    for i, c in enumerate(cols):
        cell = table.rows[0].cells[i]
        cell.width = widths[i]
        cell.text = ''
        run = cell.paragraphs[0].add_run(c)
        set_cn_font(run, size=8.5, bold=True)
        cell.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
        shd = cell._tc.get_or_add_tcPr()
        el = shd.makeelement(qn('w:shd'), {qn('w:fill'): 'D9E2F3'})
        shd.append(el)
    # 表头跨页重复
    table.rows[0]._tr.get_or_add_trPr().append(parse_xml(r'<w:tblHeader %s/>' % nsdecls('w')))

    for ip in sorted(per, key=lambda k: (per[k]['group'], k)):
        v = per[ip]
        vals = [v['group'], ip, v['zone'], v['role'],
                str(v['h1']), '%.0f%%' % (v['cross'] / max(v['h1'], 1) * 100), str(v['h2']),
                ','.join(str(p) for p, _ in v['top_ports'].most_common(3))]
        cells = table.add_row().cells
        for i, val in enumerate(vals):
            cells[i].width = widths[i]
            cells[i].text = ''
            run = cells[i].paragraphs[0].add_run(val)
            set_cn_font(run, size=8)
            cells[i].paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.LEFT if i in (1, 7) else WD_ALIGN_PARAGRAPH.CENTER

    note = doc.add_paragraph()
    set_cn_font(note.add_run('注：一跳为去重后的节点数；跨域占比 = 一跳节点中安全域与 master 不同者所占比例；二跳仅表示拓扑可达。'
                            '安全域对照：DMZ 互联网接入区 · Internal 内部通用区 · App 应用逻辑区 · DB 数据库核心区。'),
                size=8, color=(0x59, 0x59, 0x59))

    # 表格行禁止跨页断开（否则会留下一条空行）
    for row in table.rows:
        row._tr.get_or_add_trPr().append(parse_xml(r'<w:cantSplit %s/>' % nsdecls('w')))

    # 三、特征
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(8)
    set_cn_font(p.add_run('三、一跳关系的三个特征'), size=13, bold=True, color=(0x1F, 0x38, 0x64))

    dom_tot = Counter()
    for v in per.values():
        for d, c in v['domains'].items():
            dom_tot[d] += c
    dsum = sum(dom_tot.values()) or 1
    txt = '（1）对端域构成：%s。master 主要面向互联网接入区与内部通用区，数据库核心区接触最少。' % (
        '、'.join('%s %d 个（%.0f%%）' % (d, dom_tot[d], dom_tot[d] / dsum * 100)
                 for d in DOMAINS if dom_tot.get(d)))
    para = doc.add_paragraph()
    set_cn_font(para.add_run(txt), size=10.5)

    txt2 = ('（2）端口是比 IP 更强的分类特征。%s 这 5 个端口的访问关系数合计占 %.0f%%，'
            '剩下的长尾端口高度分散，适合用"按端口段归类 + 默认拒绝"的方式收敛规则。'
            % ('、'.join(str(p) for p, _ in stats['top5']), stats['top5_share']))
    para = doc.add_paragraph()
    set_cn_font(para.add_run(txt2), size=10.5)

    low = [ip for ip in per if per[ip]['h1'] <= 6]
    txt3 = ('（3）访问面差异很大：%s 等 %d 个 master 的一跳节点数不超过 6 个，可以直接按"点对点白名单"管理；'
            '而一跳超过 30 个的 master 需要按端口与对端域分组设规则，避免规则爆炸。'
            % ('、'.join(low[:4]) if low else '（无）', len(low)))
    para = doc.add_paragraph()
    set_cn_font(para.add_run(txt3), size=10.5)

    # 四、用法
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(8)
    set_cn_font(p.add_run('四、对安全域划分与流量分类的用法'), size=13, bold=True, color=(0x1F, 0x38, 0x64))
    for b in [
        '以 master 为一侧、对端安全域为另一侧，先画出"域间允许矩阵"，再用 03_端口分布 里的端口填充规则。',
        '把 %d 条有向访问关系按 (master, 方向, 端口) 收敛，可压到 %d 条规则左右，是规则量的下界参考。'
        % (stats['total_edges'], stats['port_rows']),
        '双向关系（%d 个）建议单独标注，写策略时两侧都要放行，避免只写单向导致业务中断。' % stats['bi'],
        '二跳（%d 个）只作为暴露面提示，不要直接转成允许规则；跨域二跳尤其需要单独评审。' % stats['total_h2'],
    ]:
        para = doc.add_paragraph(style='List Number')
        set_cn_font(para.add_run(b), size=10.5)

    # 五、附
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(8)
    set_cn_font(p.add_run('五、口径与数据限制'), size=13, bold=True, color=(0x1F, 0x38, 0x64))
    for b in [
        '一跳 = 与 master 直接存在访问关系的节点（按节点去重）；同一对端双向时计 2 条边。',
        '安全域取自图中节点属性（DMZ / Internal / App / DB / External / Management）。',
        '数据源未提供字节数，权重 weight 仅代表会话/记录数，不能当流量大小使用。',
        '配套明细表：master节点一跳关系_交付版.xlsx（总览、%d 行一跳清单、%d 行端口分布）。'
        % (stats['hop1_rows'], stats['port_rows']),
    ]:
        para = doc.add_paragraph(style='List Bullet')
        set_cn_font(para.add_run(b), size=10)

    # 标题不要落在页脚孤行：与后文绑定，并收紧段前距
    for para in doc.paragraphs:
        if para.runs and para.runs[0].font.size == Pt(13):
            para.paragraph_format.keep_with_next = True
            para.paragraph_format.space_before = Pt(6)

    doc.save(OUT_DOCX)


def main():
    groups = read_masters()
    nodes, edges, out_adj, in_adj, meta = load_graph(GRAPH)
    per, hop1_rows, port_rows, domain_rows = compute(groups, nodes, edges, out_adj, in_adj)
    stats = build_xlsx(groups, None, per, hop1_rows, port_rows, domain_rows, meta)
    build_docx(stats, groups)
    print(json.dumps({
        'xlsx': OUT_XLSX, 'docx': OUT_DOCX,
        'n_master': stats['n_master'], 'groups': stats['groups'],
        'total_h1': stats['total_h1'], 'total_edges': stats['total_edges'],
        'total_h2': stats['total_h2'], 'cross_pct': round(stats['cross_pct'], 1),
        'bi_pct': round(stats['bi_pct'], 1),
        'top5': stats['top5'], 'top5_share': round(stats['top5_share'], 1),
        'hop1_rows': stats['hop1_rows'], 'port_rows': stats['port_rows'],
        'domain_rows': stats['domain_rows'],
    }, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
