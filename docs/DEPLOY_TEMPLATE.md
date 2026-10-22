# ClusterInte-lligence 部署包

- BUILD_ID: `__BUILD_ID__`
- 打包时间: __STAMP__
- 构建方式: 本地（Windows）`next build --webpack` + `tsup` → 服务器**不需要**执行 next build

## 包内有什么

| 路径 | 作用 |
| --- | --- |
| `.next/` | 前端构建产物（已剔除 cache / dev / standalone / turbopack / diagnostics） |
| `dist/server.js` | 生产入口（自定义 Node server，端口取 `PORT`，默认 5000） |
| `public/` | 静态资源 + 真实拓扑数据（不在 git 里，必须随包上传） |
| `scripts/` | 数据入库 / 回填 / 分区脚本（可选） |
| `package.json` `pnpm-lock.yaml` `.npmrc` | 依赖清单（服务器上装 Linux 原生二进制） |
| `next.config.ts` | 运行期会被 next 读取，别删 |
| `ecosystem.config.js` | pm2 配置，`cwd: __dirname`，script = `./dist/server.js` |
| `.env.example` | 环境变量模板（真实 `.env.local` 不进包） |

**不含 node_modules**：本地是 win32 二进制（`@next/swc-win32-x64-msvc` / `@img/sharp-win32-x64`），
搬到 Linux 会直接启动失败，所以必须在服务器上装依赖。

## 服务器步骤

```bash
# 1) 解压（覆盖式更新）
mkdir -p /var/www/cluster-intelligence
tar -xzf cluster-intelligence-build.tar.gz -C /var/www/cluster-intelligence
cd /var/www/cluster-intelligence

# 2) 环境变量（必须放部署目录内，与 dist/server.js 同级）
cp .env.example .env.local
vi .env.local        # 至少填 NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD / PYTHON_BIN
chmod 600 .env.local

# 3) 只装依赖，不构建（必须在 Linux 上执行）
pnpm install --prod --frozen-lockfile

# 4) 启动
pm2 delete nextjs-app 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save
```

PM2 之外的前台跑法：`COZE_PROJECT_ENV=PROD PORT=5000 node dist/server.js`

## 验证

```bash
cat .next/BUILD_ID                 # 必须等于 __BUILD_ID__
curl -s localhost:5000/api/health  # status: ok / degraded（degraded 只代表 Neo4j 没连上）
curl -sI localhost:5000/           # 200
```

页面无变化时按顺序查：BUILD_ID 对不对 → `pm2 describe nextjs-app` 的 exec cwd 是不是这个目录 →
浏览器强刷 Ctrl+Shift+R → 确认没在跑 `.next/standalone/server.js`（本包不含 standalone）。

## 注意事项

1. `"next start" does not work with "output: standalone"` 启动警告可忽略：本项目用 `dist/server.js` 自定义入口。
2. `NEXT_PUBLIC_*`（如 `NEXT_PUBLIC_MONITOR_IPS`）在**构建时**内联进前端产物，改它必须重新打包，光重启无效。
3. 数据入库（服务器已有 Neo4j 时）：

   ```bash
   pip3 install -r scripts/requirements.txt
   python3 scripts/import_topology_json_to_neo4j.py --input public/topology_for_frontend_new2.0.json --clear
   python3 scripts/compute_flow_zones.py
   ```
