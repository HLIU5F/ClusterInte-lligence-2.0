# 部署说明  BUILD_ID = x3K_otGFkeV_NkERB2Ynr

本包已包含**构建产物**，服务器上**不需要执行 next build**（省内存）。

## 服务器步骤

1) 解压
   mkdir -p /root/app && tar -xzf deploy-x3K_otGFkeV_NkERB2Ynr.tar.gz -C /root/app

2) 放入 .env.local（含 NEO4J_* / MONITOR_IPS / PYTHON_BIN）
   —— 必须放**部署目录内**（与 server.js 同级）

3) 只装依赖，不构建（必须在 Linux 上装，本地产物没有 Linux 原生二进制）
   cd /root/app
   pnpm install --frozen-lockfile --prod

4) 启动
   pm2 delete nextjs-app 2>/dev/null || true
   pm2 start ecosystem.config.js
   pm2 save

## 验证（关键是确认服务器真的换了产物）

   cat .next/BUILD_ID        # 必须等于 x3K_otGFkeV_NkERB2Ynr
   curl -s localhost:5000/api/health

## 如果页面「没变化」，按这个顺序查

   a) BUILD_ID 对不上 -> 包没解压到 pm2 实际读取的目录
   b) pm2 describe nextjs-app | grep -Ei "script path|exec cwd"
      若 exec cwd 是 /root/deploy-package 之类的旧路径 -> 上传新目录永不生效，
      必须 pm2 delete nextjs-app 后用包内 ecosystem.config.js 重新 start
   c) 浏览器强刷 Ctrl+Shift+R
   d) 确认没在跑 .next/standalone/server.js —— 那是另一份产物，本包不含

## 为什么不打包 node_modules

本地是 win32 原生二进制（@next/swc-win32-x64-msvc / @img/sharp-win32-x64 等），
搬到 Linux 会运行失败。所以改为服务器只跑 pnpm install —— 内存占用远低于 next build。

## 数据入库（服务器已有 Neo4j 时）

   pip3 install -r scripts/requirements.txt
   python3 scripts/import_topology_json_to_neo4j.py --input public/topology_for_frontend_new2.0.json --clear
   python3 scripts/compute_flow_zones.py
