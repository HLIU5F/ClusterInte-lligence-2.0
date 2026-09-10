# ClusterInte-lligence 2.0

> 基于图算法与异常检测的集群拓扑智能分析平台

ClusterInte-lligence 2.0 是一个面向网络安全与运维团队的**交互式拓扑可视化与分析工具**。项目以 Neo4j 图数据库为数据底座，结合社区发现（Louvain/WCC）、异常检测（Isolation Forest）等算法，自动对集群网络流量进行安全域划分、枢纽识别与风险评分，并通过 Next.js 前端提供实时探索能力。

---

## 🎬 演示视频

<p align="center">
  <a href="https://github.com/HLIU5F/ClusterInte-lligence-2.0/releases/download/v0.1.0/2026-09-10.102448.mp4">
    <img src="https://github.com/HLIU5F/ClusterInte-lligence-2.0/releases/download/v0.1.0/2026-08-27.110842.png" alt="Demo Video Thumbnail" width="800" />
  </a>
  <br/>
  <em>👆 点击截图观看完整演示视频</em>
</p>

---

## 📸 功能截图

| 拓扑总览 | 安全域聚类 |
|:--------:|:----------:|
| ![Topology Overview](https://github.com/HLIU5F/ClusterInte-lligence-2.0/releases/download/v0.1.0/2026-08-25.091705.png) | ![Security Zones](https://github.com/HLIU5F/ClusterInte-lligence-2.0/releases/download/v0.1.0/2026-08-25.092520.png) |

| 异常检测 & 告警 | Inspector 详情面板 |
|:---------------:|:------------------:|
| ![Anomaly Detection](https://github.com/HLIU5F/ClusterInte-lligence-2.0/releases/download/v0.1.0/2026-08-25.145128.png) | ![Inspector Panel](https://github.com/HLIU5F/ClusterInte-lligence-2.0/releases/download/v0.1.0/2026-08-27.110842.png) |

---

## ✨ 核心功能

| 模块 | 说明 |
|------|------|
| **拓扑可视化** | 基于 D3.js 的力导向图，支持缩放、拖拽、节点聚焦、物理引擎参数调节 |
| **社区发现 & 安全域聚类** | 集成 Louvain / WCC 算法，自动推导安全域标签与颜色编码 |
| **异常检测** | Isolation Forest 异常评分 + 多级告警规则（Critical / High / Medium / Low） |
| **GDS 图算法** | PageRank 枢纽识别、度中心性分析、子网 / 端口 / 协议多维索引 |
| **数据丰富器** | GeoIP、服务指纹、CMDB 标签、业务分组等外部数据自动关联 |
| **基线规则引擎** | 可配置的阈值规则（异常分数、流量大小、连接数等），实时高亮 |
| **白名单管理** | 对已知正常资产进行豁免，降低误报噪声 |
| **Inspector 面板** | 点击节点查看完整属性、关联边、历史日志与丰富化信息 |
| **暗色 / 亮色主题** | 一键切换，适配不同工作环境 |

---

## 🏗️ 技术栈

- **前端**: Next.js (App Router) + React + TypeScript + Tailwind CSS + shadcn/ui
- **可视化**: D3.js v7 + graphology
- **图数据库**: Neo4j (Cypher 25) + GDS 插件
- **后端 API**: Next.js Route Handlers + neo4j-driver
- **数据处理**: Python (pandas / scikit-learn) + Node.js ETL 脚本
- **包管理**: pnpm（强制）
- **部署**: 自定义 Node.js HTTP Server（`src/server.ts`），默认端口 `5000`

---

## 📁 项目结构

```
├── src/
│   ├── app/                # Next.js App Router 页面 & API
│   ├── components/         # UI 组件（拓扑图、面板、Inspector 等）
│   ├── hooks/              # 自定义 React Hooks
│   ├── lib/                # 核心逻辑
│   │   ├── clustering.ts       # 社区发现 & 安全域推导
│   │   ├── isolationForest.ts  # 异常检测算法
│   │   ├── topology-api.ts     # Neo4j 数据加载
│   │   ├── localGds.ts         # 本地 GDS 算法实现
│   │   ├── cmdbSimilarity.ts   # CMDB 标签相似度
│   │   └── types.ts            # TypeScript 类型定义
│   └── server.ts           # 自定义 Node.js 入口
├── scripts/                # ETL、导入、分析、验证脚本
├── public/                 # 静态拓扑数据 JSON / CSV
├── neo4j.conf              # Neo4j 配置参考
└── package.json
```

---

## 🚀 快速开始

### 前置要求

- Node.js >= 18
- pnpm（`npm install -g pnpm`）
- Neo4j >= 5.x（建议启用 GDS 插件）
- Python >= 3.9（用于数据预处理脚本）

### 安装 & 运行

```bash
# 1. 克隆仓库
git clone https://github.com/HLIU5F/ClusterInte-lligence-2.0.git
cd ClusterInte-lligence-2.0

# 2. 安装依赖（仅允许 pnpm）
pnpm install

# 3. 配置环境变量
cp .env.example .env.local  # 如无 .env.example 请手动创建

# 4. 导入数据到 Neo4j（按需选择脚本）
node scripts/import_purified_to_neo4j.js
# 或使用 Python 脚本
python scripts/import_to_neo4j.py

# 5. 启动开发服务器
pnpm dev

# 6. 生产构建 & 启动
pnpm build
pnpm start
```

服务默认监听 `http://localhost:5000`。

---

## ⚙️ 环境变量

在 `.env.local` 中配置以下变量：

| 变量 | 说明 | 示例 |
|------|------|------|
| `NEO4J_URI` | Neo4j Bolt 连接地址 | `bolt://localhost:7687` |
| `NEO4J_USER` | Neo4j 用户名 | `neo4j` |
| `NEO4J_PASSWORD` | Neo4j 密码 | `your_password` |
| `PORT` | 服务监听端口 | `5000` |
| `HOSTNAME` | 绑定主机名 | `localhost` |
| `COZE_PROJECT_ENV` | 运行环境标识 | `PROD` / 留空为开发模式 |

---

## 🔧 可用脚本

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 启动 Next.js 开发服务器 |
| `pnpm build` | 执行生产构建（调用 `scripts/build.sh`） |
| `pnpm start` | 启动生产服务（调用 `scripts/start.sh`） |
| `pnpm validate` | 并行执行 TypeScript 检查 + ESLint + Stylelint |
| `pnpm lint` | ESLint 代码检查 |
| `pnpm lint:style` | CSS / Tailwind 样式检查 |

### 数据处理脚本（`scripts/`）

| 脚本 | 用途 |
|------|------|
| `import_purified_to_neo4j.js` | 将净化后的拓扑数据导入 Neo4j |
| `import_raw_flows.js` | 导入原始流量日志 |
| `build_purified_data.js` | 构建净化数据集 |
| `enhance_security_data_v2.js` | 安全数据增强 V2 |
| `apply_enrichers.py` | 批量应用数据丰富器 |
| `preprocess.py` | 数据预处理 |
| `check_coverage.js` | 检查数据覆盖率 |
| `validate.sh` | 数据完整性验证 |

---

## 📊 数据流架构

```
原始流量日志 / CMDB
        ↓
  Python / Node ETL 脚本
        ↓
  Neo4j 图数据库 (GDS)
        ↓
  Next.js API Routes
        ↓
  D3.js 交互式拓扑图
        ↓
  安全域 · 异常评分 · 枢纽识别 · 基线告警
```

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request。提交前请确保通过验证：

```bash
pnpm validate
```

---

## 📄 License

本项目暂未声明开源许可证。如需商用或二次分发，请联系仓库所有者获取授权。

---

<p align="center">
  <b>ClusterInte-lligence 2.0</b> — 让集群拓扑 intelligible, actionable, secure.
</p>
