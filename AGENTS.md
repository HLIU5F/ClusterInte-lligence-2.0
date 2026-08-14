# AGENTS.md - Cluster Intelligence System

## 项目概览
基于流量特征的网络拓扑可视化与安全域分析平台。使用 D3.js 力导向图展示机器间的访问关系，支持安全域划分、安全基线配置、异常检测和数据导入。

## 技术栈
- **Framework**: Next.js 16 (App Router)
- **Core**: React 19
- **Language**: TypeScript 5
- **UI**: shadcn/ui + Tailwind CSS 4
- **Visualization**: D3.js v7
- **Package Manager**: pnpm

## 目录结构
```
src/
├── app/
│   ├── layout.tsx          # 根布局（暗色主题）
│   ├── page.tsx            # 主页面（拓扑图 + 侧边栏）
│   ├── globals.css         # 全局样式（暗色安全主题 + 光圈动画）
│   └── api/
│       └── import/
│           └── route.ts    # Excel/JSON 数据导入 API
├── components/
│   ├── topology-graph.tsx  # D3.js 力导向拓扑图核心组件（含异常光圈）
│   ├── sidebar.tsx         # 侧边栏（安全域/基线/详情/控制/导入）
│   └── ui/                 # shadcn/ui 组件库
├── lib/
│   ├── types.ts            # 类型定义（节点/边/安全域/基线规则）
│   ├── mockData.ts         # Mock 数据生成器
│   ├── dataConverter.ts    # 原始流量日志 → 拓扑数据转换器
│   └── utils.ts            # 通用工具函数
└── hooks/
    └── use-mobile.ts       # 移动端检测 Hook
```

## 核心功能
1. **拓扑图可视化**: D3.js 力导向图，支持缩放/拖拽/搜索/高亮邻居
2. **安全域管理**: 按社区着色、聚焦、统计
3. **安全基线**: 可配置的基线规则，自动检测违规节点
4. **数据导入**: 支持 Excel（原始流量日志）和 JSON（拓扑数据）格式导入
5. **异常检测**: 异常节点红色光圈脉冲动画，分级展示
6. **过滤控制**: 边权重过滤、节点度数过滤、标签显示切换
7. **数据转换**: 自动将原始网络日志转换为拓扑图格式（IP→节点，通信→边，子网→社区）

## 数据格式

### Excel 格式（原始流量日志）
| 字段 | 说明 | 示例 |
|------|------|------|
| proto | 协议 | tcp |
| src | 源 IP | 10.20.3.25 |
| dst | 目标 IP | 10.26.0.26 |
| dport | 目标端口 | 9094 |
| deviceDirection | 方向 | IN/OUT |

### JSON 格式（拓扑数据）
```json
{
  "metadata": { "generated_at": "...", "source": "...", "total_nodes": N, "total_links": M, "communities": K },
  "nodes": [{ "id": "10.0.0.1", "community": 0, "degree": 45, "anomaly_score": 0.12, ... }],
  "links": [{ "source": "10.0.0.1", "target": "10.0.0.2", "weight": 120, "bytes": 10485760 }]
}
```

## 开发命令
- `pnpm dev` - 启动开发服务器
- `pnpm build` - 构建生产版本
- `pnpm start` - 启动生产服务器
- `pnpm ts-check` - TypeScript 类型检查
- `pnpm lint` - ESLint 检查

## 设计规范
- 暗色安全运营中心主题
- 主强调色: #00d4ff (cyan)
- 社区色板: 12色循环
- 异常节点: 红色脉冲动画
- 数据字体: JetBrains Mono
- 详见 DESIGN.md
