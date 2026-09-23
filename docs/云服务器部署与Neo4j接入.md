# 云服务器部署与 Neo4j 接入手册

> 面向「服务器内存不够、暂时没有 Neo4j」的现实场景。
> 目标：先把前端 + 本地图算法跑起来，再按需逐步接入图数据库。

---

## 0. 先搞清楚：没有 Neo4j 时，什么能用、什么不能用

项目对 Neo4j 是**软依赖**——图数据库只是数据源之一，不是启动前提。

| 能力 | 没有 Neo4j 时 | 说明 |
| --- | --- | --- |
| 页面 / 拓扑渲染 / 安全域聚类 / 异常检测 | ✅ 可用 | 纯前端计算 |
| 「加载业务核心图」 | ✅ 可用 | 读 `public/topology_data_core.json`，缺失时自动回退 `public/topology_demo.json`（合成数据） |
| Excel / JSON 导入 | ✅ 可用 | `/api/import` |
| Louvain / WCC（GDS 面板） | ✅ 降级可用 | Neo4j 不可用时自动改用 `src/lib/localGds.ts` 的浏览器本地实现 |
| 最短路径 / 攻击链 | ✅ 降级可用 | 后端 503 时自动改用本地 BFS（`findPathLocally`） |
| N 跳邻居展开 | ✅ 降级可用 | 后端失败时自动改用 `expandLocally` |
| 「从 Neo4j 加载」 | ❌ | 会弹出失败提示并询问是否改加载本地数据 |
| 资产全景导出 GET | ⚠️ | 依赖 `public/topology_data_security.json`（不入库），文件缺失时 500 |
| 单 IP Enrich | ⚠️ | 依赖 `PYTHON_BIN` 与 `scripts/requirements.txt` |

一句话：**不装 Neo4j 也能演示完整前端与图算法，只是数据源换成静态 JSON。**

---

## 1. 首次拉取与安装

```bash
git clone https://github.com/HLIU5F/ClusterInte-lligence-2.0.git
cd ClusterInte-lligence-2.0
git checkout main

# Node 需要 >= 20（Next 16 要求），推荐 20 或 22 LTS
node -v

# 依赖只能装一次，低内存机器务必串行、别并发
pnpm install --frozen-lockfile
```

> ⚠️ **`scripts/server_migrate.sh` 只用于「旧 clone 迁移到重写后的历史」**。
> 全新 clone 不需要它；误执行 `migrate` 会重新 clone 并移动目录。
> 只需要它的 `prepare` 子命令（回填真实数据 + 生成 `.env.local` 模板）。

### Python 环境（只有要用 Enrich 才需要）

```bash
pip3 install -r scripts/requirements.txt
# 或者用虚拟环境，避免污染系统 Python
python3 -m venv .venv && . .venv/bin/activate && pip install -r scripts/requirements.txt
```

---

## 2. 配置 `.env.local`

```bash
cp .env.example .env.local
chmod 600 .env.local
vi .env.local
```

**最低限度**（暂时不接 Neo4j 时）只需要确认这两项：

```ini
PYTHON_BIN=python3
NEXT_PUBLIC_MONITOR_IPS=<你的采集/汇聚/安全设备 IP，逗号分隔>
```

其余 Neo4j 项可以留占位值，页面照常工作。

### 关于 `NEXT_PUBLIC_*` 的坑

`NEXT_PUBLIC_MONITOR_IPS` 在 **`next build` 期间被内联进前端产物**。
改了它必须重新 build，只重启进程无效：

```bash
pnpm build && pm2 restart nextjs-app --update-env
```

---

## 3. 构建

```bash
bash ./scripts/build.sh
```

它依次做三件事：

1. `pnpm install --prefer-frozen-lockfile --prefer-offline`
2. `pnpm next build --webpack`
3. `pnpm tsup src/server.ts --format cjs --platform node --target node20 --outDir dist`

产物：`.next/`（前端）+ `dist/server.js`（自定义 Node 入口）。

### 内存不够时的构建参数

Next 构建是最吃内存的一步。若 `Killed` / `OOM`：

```bash
# 限制 Node 堆，让 GC 更早介入（在 1GB 内存机器上很有用）
NODE_OPTIONS="--max-old-space-size=640" bash ./scripts/build.sh

# 仍然 OOM 时：临时加 swap（Docker 容器内通常无效，需要宿主机加）
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
free -h
```

---

## 4. 启动

### 方式 A：pm2（推荐）

```bash
pm2 start ecosystem.config.js
pm2 logs nextjs-app
pm2 save && pm2 startup     # 开机自启
```

`ecosystem.config.js` 已修正为 `cwd: __dirname`（旧版硬编码 `/root/deploy-package`，换目录后 pm2 会找不到 `dist/server.js`）。

调整堆上限：

```bash
NODE_MAX_OLD_SPACE=384 pm2 restart ecosystem.config.js --update-env
```

`instances: 1` 是刻意的：小内存机器上多实例会各自占一份堆，几乎必然 OOM。

### 方式 B：直接前台跑

```bash
bash ./scripts/start.sh          # PORT 默认 5000
PORT=8080 bash ./scripts/start.sh
```

### 方式 C：不推荐

`pnpm start` 走的是 `next start`（默认端口 3000），与生产部署用的自定义 server（5000）**不是同一条路径**。
排查问题时别混用，统一用 `pm2` 或 `scripts/start.sh`。

---

## 5. 验证：先看自检端点

```bash
curl -s localhost:5000/api/health | python3 -m json.tool
```

返回结构（节选）：

```json
{
  "status": "degraded",
  "app": { "node": "v20.x", "env": "PROD", "port": "5000" },
  "neo4j": {
    "ok": false,
    "code": "NEO4J_UNREACHABLE",
    "error": "无法连接 Neo4j：http://localhost:7474/db/neo4j/tx/commit（fetch failed）",
    "hint": "确认 Neo4j 已启动、7474 端口对本机开放……",
    "bolt_uri": "bolt://localhost:7687",
    "http_url": "http://localhost:7474",
    "database": "neo4j",
    "missing_settings": [],
    "counts": null
  },
  "data_files": [
    { "name": "topology_data_core.json", "present": false },
    { "name": "topology_demo.json", "present": true }
  ],
  "hints": ["Neo4j 未就绪时前端仍可用：……"]
}
```

`status` 语义：

- `ok` —— 应用活着 **且** Neo4j 可查询
- `degraded` —— 应用活着，但 Neo4j 不可用（**这不是 5xx**，方便区分「进程挂了」和「依赖没连上」）

看库里的真实规模：

```bash
curl -s "localhost:5000/api/health?deep=1" | python3 -m json.tool
```

### 错误码对照

| code | HTTP | 含义 | 处理 |
| --- | --- | --- | --- |
| `NEO4J_NOT_CONFIGURED` | 503 | `.env.local` 里没有 `NEO4J_PASSWORD` | 填密码后重启 |
| `NEO4J_UNREACHABLE` | 503 | 连不上 7474，或认证失败 | 起容器 / 查密码 / 查端口 |
| `NEO4J_QUERY_ERROR` | 500 | Cypher 报错，通常缺 GDS 插件 | 装 GDS |
| `INTERNAL_ERROR` | 500 | 代码 bug | 看服务端日志 |

### 页面自检

1. 打开 `http://<服务器IP>:5000`
2. 右侧「数据源」→「加载业务核心图」→ 应出现拓扑图
3. 「算法」→ 跑 Louvain → 若 Neo4j 不可用，应在面板看到「本地图算法」的降级标记

---

## 6. 接入 Neo4j

### 内存预算先算清楚

Neo4j 自身是 JVM 应用：**空载约 500MB–1GB**，加 GDS 插件与图数据还会涨。
如果服务器总内存 ≤ 2GB，**建议先不装**，用第 0 节的本地降级模式演示；等扩容后再接。

### 6.1 Docker 方式（推荐）

```bash
docker run -d --name neo4j-db \
  -p 127.0.0.1:7474:7474 -p 127.0.0.1:7687:7687 \
  -v $HOME/neo4j/data:/data \
  -v $HOME/neo4j/plugins:/plugins \
  -e NEO4J_AUTH=neo4j/<你的密码> \
  -e NEO4J_server_memory_pagecache_size=512M \
  -e NEO4J_server_memory_heap_initial__size=512M \
  -e NEO4J_server_memory_heap_max__size=512M \
  -e NEO4J_PLUGINS='["graph-data-science"]' \
  neo4j:5
```

> ⚠️ **镜像 tag 必须与已有数据卷的版本一致** —— Neo4j 不能降级打开旧 store，用错 tag 会直接启动失败。
> 先查现有版本，这个端点**不需要认证**：
>
> ```bash
> curl -s localhost:7474/ | python3 -m json.tool
> # {"bolt_routing":"...","neo4j_version":"2026.06.0","neo4j_edition":"community"}
> ```
>
> 把示例里的 `neo4j:5` 换成匹配的 tag（`2026.06.0` → `neo4j:2026.06`）；只有全新部署才用 `neo4j:5`。
> GDS 插件版本同样要与 Neo4j 大版本匹配，见 6.2。

要点：

- **端口绑 `127.0.0.1`**，不要 `0.0.0.0`：Neo4j 直接暴露公网是重大风险，应用同机访问即可
- `NEO4J_PLUGINS='["graph-data-science"]'` 会自动下载 GDS（需要容器能出网）
- 三个 memory 环境变量把 JVM 限制在 512M，这是低内存机器上最关键的一步

仓库里的 `neo4j.conf` 是配置参考，其中已有：

```ini
server.memory.pagecache.size=512M
server.default_listen_address=0.0.0.0
```

> 注意 `server.default_listen_address=0.0.0.0`：这是给容器内监听的，**不要把 7474/7687 映射到公网**。

### 6.2 离线装 GDS 插件

服务器不能出网时：

1. 在能出网的机器下载与 Neo4j 大版本匹配的 `neo4j-graph-data-science-*.jar`
2. 放到 `$HOME/neo4j/plugins/`（挂载到容器 `/plugins`）
3. 在 `neo4j.conf` 里加：

   ```ini
   dbms.security.procedures.unrestricted=gds.*
   dbms.security.procedures.allowlist=gds.*
   ```

4. 重启容器，验证：

   ```bash
   docker exec -it neo4j-db cypher-shell -u neo4j -p '<密码>' \
     "RETURN gds.version() AS gds_version"
   ```

> 仓库根有 `.gitignore` 规则 `neo4j-plugins/`，所以 GDS jar **不在仓库里**，必须自行准备。

### 6.3 配置应用连接

```ini
# .env.local
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=<真实密码>
NEO4J_DB=neo4j
NEO4J_DATABASE=neo4j
NEO4J_TIMEOUT_MS=8000
```

**只需要 `NEO4J_URI`**：HTTP 地址会自动从 Bolt 地址推导（`7687 → 7474`，`bolt+s` → `https`）。
只有反向代理或端口非默认时才需要显式写 `NEO4J_HTTP_URL`。

改完重启并复验：

```bash
pm2 restart nextjs-app --update-env
curl -s localhost:5000/api/health | python3 -m json.tool
```

### 6.4 连通性自检脚本

```bash
python3 scripts/test_neo4j.py
```

它从 `.env.local` 读凭据（经 `scripts/env.py`），不会硬编码密码。

---

## 7. 导入数据

```bash
# 拓扑 JSON → Neo4j（含 CMDB 维度实体化）
python3 scripts/import_to_neo4j.py --input scripts/topology_data_core.json

# 先干跑，确认要写什么
python3 scripts/import_to_neo4j.py --input <file> --dry-run
```

> ⚠️ `public/topology_data*.json` 等真实网络数据**不在仓库里**（`.gitignore` 明确排除）。
> 需要先把真实数据放回 `public/`：
>
> ```bash
> bash scripts/server_migrate.sh prepare     # 从 $HOME/topo_backup 回填
> ```
>
> 没数据时页面会自动用 `public/topology_demo.json`（RFC 5737 合成网段）。

---

## 8. 故障对照表

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `pnpm install` 被杀 | 内存不足 | 加 swap；或 `--child-concurrency=1` |
| `next build` OOM | 构建峰值内存 | `NODE_OPTIONS=--max-old-space-size=640`；加 swap |
| pm2 报找不到 `dist/server.js` | `cwd` 不对（旧版硬编码） | 用修正后的 `ecosystem.config.js`，或 `pm2 delete` 后重起 |
| 页面能开但点「从 Neo4j 加载」失败 | 库未起 / 端口未通 | `curl -s localhost:5000/api/health`，看 `code` |
| `unknown function gds.louvain` | 缺 GDS 插件 | 见 6.2 |
| 容器 `Exited 137` | OOM Killer | 调小 Neo4j heap，或给机器加内存 |
| 导出资产全景 500 | `public/topology_data_security.json` 缺失 | `bash scripts/server_migrate.sh prepare` 回填 |
| 启动时报 `"next start" does not work with "output: standalone"` | `next.config.ts` 的 `output: 'standalone'` 与 `next start` 语义冲突 | **可忽略**：本项目用的是自定义 server（`src/server.ts`），直接处理请求。实测页面与全部 `/api/*` 均正常，只是警告 |
| `/api/health` 的 detail 含 `Invalid credential` / `HTTP 401` | `.env.local` 里的密码与容器不一致（**库本身是通的**） | 查容器启动时设的密码：`docker inspect neo4j-db --format "{{range .Config.Env}}{{println .}}{{end}}" \| grep NEO4J_AUTH`，把 `neo4j/<密码>` 的密码部分写回 `.env.local`，再 `pm2 restart nextjs-app --update-env` |
| 密码不确定 / 想把两边对齐 | — | 优先在 **Neo4j Browser** 里执行 `ALTER CURRENT USER SET PASSWORD FROM '<当前密码>' TO 'Neo4j@2024Secure'`，与 `.env.local` 对齐后重启服务。若连当前密码都不知道：`CREATE USER appuser SET PASSWORD 'Neo4j@2024Secure' CHANGE NOT REQUIRED;` 再 `GRANT ROLE admin TO appuser;`，然后把 `.env.local` 的 `NEO4J_USER` 改成 `appuser` |
| 复用旧数据卷启动 Neo4j 失败 | 镜像 tag 与数据卷版本不匹配（Neo4j 不能降级打开旧 store） | `curl -s localhost:7474/` 查真实版本并换匹配 tag。本项目实测环境为 **2026.06.0 Community**；该版本**没有** `/user/{user}/password` HTTP 改密端点（返回 404），改密只能走 Cypher |
| 采集节点被误判为异常 | `NEXT_PUBLIC_MONITOR_IPS` 没填 | 填好后**重新 build** |
| 改了 `.env.local` 没生效 | 进程没重启 / 前端变量未重建 | `pm2 restart --update-env`；`NEXT_PUBLIC_*` 要重新 build |

---

## 9. 两条红线

1. 🚫 **不要 `git push --force`** —— 会把含真实网络数据与密码的旧历史重新推回远端。
2. 🚫 **不要 `git clean -fdx` / `git reset --hard`** —— 会物理删除 `public/` 下已脱离 git 跟踪的真实数据文件。

---

## 10. 相关文件索引

| 路径 | 作用 |
| --- | --- |
| `src/lib/neo4jConfig.ts` | 连接参数唯一来源，Bolt → HTTP 地址推导 |
| `src/lib/neo4j.ts` | HTTP 事务端点客户端，抛出带 code 的 `Neo4jError` |
| `src/lib/apiErrors.ts` | 路由层统一错误响应（`{ error, code, detail, hint }`） |
| `src/app/api/health/route.ts` | 自检端点 |
| `src/lib/topology-api.ts` | 前端 API 封装 + `ApiError` / `describeApiError` |
| `src/lib/localGds.ts` | 无 Neo4j 时的本地 WCC / Louvain |
| `scripts/server_migrate.sh` | 真实数据备份 / 回填 / 体检 |
| `scripts/build.sh` / `scripts/start.sh` | 生产构建 / 启动 |
| `ecosystem.config.js` | pm2 配置（含堆上限） |

---

## 附录 A：数据集怎么选（实测结论）

`public/` 下的静态数据集结构差异极大，**选错会出现「加载成功但分析不出东西」**。
前端「数据源 → 静态数据集」下拉框可切换；下表规模为真实计数：

| 文件 | 节点 / 边 | 结构实况 | 适合做什么 |
| --- | --- | --- | --- |
| `topology_data_core.json` | 212 / 211 | **星型**：1 个采集 hub（`10.100.113.134`）连 211 个叶子，**叶子度数全为 1**，`zone_label` 为空 | 快速演示、验证聚类与导出流水线 |
| `topology_demo.json` | 210 / 237 | 合成数据（RFC 5737 网段） | 公开演示；无真实数据时的兜底 |
| **`topology_for_frontend_new2.0.json`** | 3358 / **23741** | **新基线关系图**：平均度 14.14、6 个连通分量、模块度 **Q=0.67**，含 6 类安全域 + `asset_value` + 270 个预计算社区 | ✅✅ **首选**：社区发现 / 跨域攻击链 / 资产价值排序 |
| `topology_for_frontend.json` | 3739 / **8893** | **主机间访问关系**，平均度 4.76，1 个孤立节点、2 个连通分量，边带 ports/bytes，`zone_label` 齐全 | ✅ **社区发现 / 枢纽识别 / 异常检测** |
| `topology_data_security_enhanced.json` | 3736 / 211 | 星型核心 + 3524 个孤立节点（平均度 0.11，3525 个连通分量） | 资产台账、端口 / 子网统计 |
| `topology_data_security.json` | 3736 / 211 | 同上 | 资产台账 |
| `topology_data_purified.json` | 3736 / 211 | 同上 | 资产台账 |

### 为什么「业务核心图」做不了图分析

它是**采集节点 ↔ 被采集节点**的星型流量（样本边的端口是 `36000`，即监控上报端口），因此：

- WCC 只有 **1 个连通分量**
- Louvain 只能分出 **1~2 个社区**（前端代码因此会自动回退到规则分组）
- PageRank 必然把那个 hub 排第一，**没有区分度**
- 每条边都是 hub↔叶子，**跨安全域边没有意义**

这正是项目文档里记录的「模块度 -0.2559、域内连接占比 0%」的根因 —— 不是算法坏了，是数据本身没有社区结构。
要做真正的图分析，请选 `topology_for_frontend.json`。

### 回归时的验证命令

```bash
# 看当前进程能连到什么、public/ 里有哪些数据文件
curl -s "localhost:5000/api/health?deep=1" | python3 -m json.tool
```

---

## 附录 B：本机实测环境快照

用于后续对照「环境是否变化」。数据由 `/api/health?deep=1` 与直接查询 Neo4j 得到。

### 应用侧

| 项 | 值 |
| --- | --- |
| `/api/health` | `status: ok`（Neo4j 已连通），`counts = { ips: 3358, links: 23741 }` |
| Node | v24.9.0 |
| 生产入口 | `node dist/server.js`，端口由 `PORT` 决定 |
| 启动警告 | `"next start" does not work with "output: standalone"` —— **可忽略**，实测页面与全部 `/api/*` 正常 |

### Neo4j 侧

| 项 | 值 |
| --- | --- |
| 版本 | **2026.06.0 Community**（`curl -s localhost:7474/` 可查，**无需认证**） |
| 部署 | Docker 容器，Windows 上由 `com.docker.backend` 转发 7474 / 7687 |
| 端口绑定 | 实测为 `0.0.0.0`（**建议改为 `127.0.0.1`**） |
| GDS 插件 | ❌ **未安装**（`RETURN gds.version()` → Unknown function）。**不影响使用**：预计算社区已入库，见下 |
| 认证 | 单用户 `neo4j`；Community 版**不支持** `CREATE USER` / `GRANT ROLE` |

### 当前库内数据（new2.0 基线关系图）

| 项 | 值 |
| --- | --- |
| 来源文件 | `public/topology_for_frontend_new2.0.json`（6.24 MB） |
| `metadata.source` | `cwp_baselineRsReplacingDistributed_cleaned_optimized` |
| 标签 | `IP`（3358）、`Subnet`（229）、`Zone`（6）、`GDSZone`（269） |
| 关系 | `CONNECTS_TO`（23741）、`BELONGS_TO`（3358）、`IN_ZONE`（3587）、`IN_GDS_ZONE`（3324） |
| 度数 | min 1 / max 1091 / avg 14.14，孤立节点 0，连通分量 6 |
| **模块度 Q** | **0.6698**（旧数据为 -0.2559 → 新数据的社区结构真实存在） |
| 安全域（`Zone`） | Internal 1180 / DMZ 1082 / App 1032 / DB 51 / External 8 / Management 5 |
| 节点额外字段 | `asset_value`（100% 覆盖）、`security_domain`、`community`、`role_guess` |
| 索引 | `ip_id_unique`、`subnet_cidr_unique`、`zone_id_unique`、`ip_subnet`、`ip_community`、`ip_domain` |

> **安全域现在从库里读**（不再全靠前端 `computeClustering` 现算）。
> `/api/topology/neo4j` 优先使用 IP 自身的 `(:IP)-[:IN_ZONE]->(:Zone)`，
> 只在缺失时才回退到「子网多数票」得到的域 —— 因为同一子网里常混着不同域的机器
> （本数据里有 **1013 台**如此，DB 域 51 台中曾有 50 台会被判错）。

### 两个已知技术债

1. ~~Neo4j HTTP API 已废弃~~ **→ 已迁移**：`src/lib/neo4j.ts` 默认走新版 Query API
   （`POST /db/{db}/query/v2`，成功返回 **HTTP 202** + `data.fields` / `data.values`），
   仅在返回 404（老版本 Neo4j 无该端点）时自动回退到旧事务端点并记住选择。
   可用 `NEO4J_HTTP_API=query|tx|auto` 强制指定，默认 `auto`。
2. **从 Neo4j 加载有节点上限保护**：默认只保留连通度最高的 **2000** 个
   （`?limit=N` 自定义、`?all=1` 拉全量，硬上限 20000），并在 `metadata` 里回传
   `truncated` / `total_ips_in_db` / `node_limit`，前端据此询问是否加载全量。
   截断时**同步过滤边**，不会产生指向被裁掉节点的悬空边。
   实测：默认 2000 节点 / 3.66 MB；`?all=1` 3358 节点 / 4.69 MB。
