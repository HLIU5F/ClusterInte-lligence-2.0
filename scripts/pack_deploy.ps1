<#
.SYNOPSIS
  本地打包部署产物 —— 供内存不足、无法在服务器上执行 next build 的场景使用。

.DESCRIPTION
  打法：本地完成构建，只把「构建产物 + 源码元数据」打包上传；
        服务器上**只跑 pnpm install（拿 Linux 原生二进制）**，不跑 next build。

  包内含：
    .next/            生产运行所需部分（**剔除 cache/ dev/ standalone/**，这三项占 433MB 且生产不用）
    dist/server.js    自定义服务入口（tsup 产物）
    public/           静态资源，含被 .gitignore 排除的真实数据文件
    scripts/          Python 导入 / 富化 / 分区脚本
    package.json / pnpm-lock.yaml / .npmrc / next.config.ts / tsconfig.json / postcss.config.mjs
    ecosystem.config.js（cwd 已改为 __dirname）/ .env.example / neo4j.conf
    DEPLOY.md         服务器侧逐步操作

  **不打包 node_modules**：本地产物里是 win32 原生二进制
  （@next/swc-win32-x64-msvc、@img/sharp-win32-x64 等），搬到 Linux 会直接运行失败。

.EXAMPLE
  .\scripts\pack_deploy.ps1              # 先构建再打包
  .\scripts\pack_deploy.ps1 -SkipBuild   # 复用现有 .next
#>
param(
  [switch]$SkipBuild,
  [switch]$KeepStaging
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Get-SizeMB($p) {
  if (-not (Test-Path $p)) { return 0 }
  $item = Get-Item $p
  if ($item.PSIsContainer) {
    return [math]::Round(((Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB), 1)
  }
  return [math]::Round(($item.Length / 1MB), 2)
}

Write-Host "`n=== 1/5 构建 ===" -ForegroundColor Cyan
if ($SkipBuild) {
  Write-Host "  跳过（-SkipBuild）"
} else {
  $env:NODE_OPTIONS = ''
  & node node_modules/next/dist/bin/next build --webpack
  if ($LASTEXITCODE -ne 0) { throw "next build 失败" }
}

if (-not (Test-Path '.next\BUILD_ID')) { throw "找不到 .next/BUILD_ID —— 请先构建" }
$buildId = (Get-Content '.next\BUILD_ID' -Raw).Trim()
Write-Host "  BUILD_ID = $buildId"

# 只在 src/server.ts 比 dist/server.js 新时才重打包（tsup 会拉起 esbuild 子进程，能省则省）
$needServerBuild = $true
if ((Test-Path 'dist\server.js') -and (Test-Path 'src\server.ts')) {
  if ((Get-Item 'dist\server.js').LastWriteTime -gt (Get-Item 'src\server.ts').LastWriteTime) {
    $needServerBuild = $false
    Write-Host "  + dist/server.js 已是最新，跳过 tsup"
  }
}
if ($needServerBuild) {
  # 原生命令往 stderr 写进度是常态，别让它中断脚本
  $prevEA = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & node node_modules/tsup/dist/cli-default.js src/server.ts --format cjs --platform node --target node20 --outDir dist --no-splitting --no-minify 2>&1 | Out-Null
  $tsupCode = $LASTEXITCODE
  $ErrorActionPreference = $prevEA
  if ($tsupCode -ne 0) { Write-Host "  ! tsup 打包失败，将沿用现有 dist/" -ForegroundColor Yellow }
  else { Write-Host "  + dist/server.js 已重建" }
}

Write-Host "`n=== 2/5 组装 staging ===" -ForegroundColor Cyan
$stage = Join-Path $root 'deploy-package'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

Copy-Item '.next' (Join-Path $stage '.next') -Recurse -Force
foreach ($junk in @('.next\cache', '.next\dev', '.next\standalone', '.next\diagnostics', '.next\turbopack')) {
  $p = Join-Path $stage $junk
  if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}
Write-Host ("  + .next/ (已剔除 cache/dev/standalone)  {0} MB" -f (Get-SizeMB (Join-Path $stage '.next')))

foreach ($d in @('dist', 'public', 'scripts', 'src', 'tests', 'config')) {
  if (Test-Path $d) {
    Copy-Item $d (Join-Path $stage $d) -Recurse -Force
    Write-Host ("  + {0}/  {1} MB" -f $d, (Get-SizeMB $d))
  }
}

# 剔除不该上服务器的东西：Windows 虚拟环境 / Python 字节码缓存 / 数据备份副本
foreach ($junk in @('scripts\.venv', 'scripts\__pycache__', 'scripts\enrichers\__pycache__', 'tests\__pycache__')) {
  $p2 = Join-Path $stage $junk
  if (Test-Path $p2) { Remove-Item $p2 -Recurse -Force; Write-Host "  - 剔除 $junk" }
}
Get-ChildItem (Join-Path $stage 'scripts') -Recurse -File -Include *.pyc -ErrorAction SilentlyContinue | Remove-Item -Force
Get-ChildItem (Join-Path $stage 'public') -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\.bak' } | ForEach-Object { Write-Host "  - 剔除 public/$($_.Name)"; Remove-Item $_.FullName -Force }

$files = @('package.json', 'pnpm-lock.yaml', '.npmrc', 'next.config.ts', 'tsconfig.json',
           'postcss.config.mjs', 'components.json', 'eslint.config.mjs', 'stylelint.config.mjs',
           'ecosystem.config.js', '.env.example', 'neo4j.conf')
$copied = 0
foreach ($f in $files) { if (Test-Path $f) { Copy-Item $f $stage -Force; $copied++ } }
Write-Host "  + 配置文件 $copied 个"

$deployDoc = @"
# 部署说明  BUILD_ID = $buildId

本包已包含**构建产物**，服务器上**不需要执行 next build**（省内存）。

## 服务器步骤

1) 解压
   mkdir -p /root/app && tar -xzf deploy-$buildId.tar.gz -C /root/app

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

   cat .next/BUILD_ID        # 必须等于 $buildId
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
"@
Set-Content -Path (Join-Path $stage 'DEPLOY.md') -Value $deployDoc -Encoding utf8
Write-Host "  + DEPLOY.md"

Write-Host "`n=== 3/5 统计 ===" -ForegroundColor Cyan
Write-Host ("  staging 总大小：{0} MB" -f (Get-SizeMB $stage))

Write-Host "`n=== 4/5 打包 ===" -ForegroundColor Cyan
$tarball = Join-Path $root "deploy-$buildId.tar.gz"
if (Test-Path $tarball) { Remove-Item $tarball -Force }
& tar -czf $tarball -C $stage .
if ($LASTEXITCODE -ne 0) { throw "tar 打包失败" }
Write-Host ("  -> {0}  ({1} MB)" -f $tarball, (Get-SizeMB $tarball))

if (-not $KeepStaging) { Remove-Item $stage -Recurse -Force }

Write-Host "`n=== 5/5 完成 ===" -ForegroundColor Green
Write-Host "  1) 上传  scp `"$tarball`" root@<服务器>:/root/"
Write-Host "  2) 解压  mkdir -p /root/app && tar -xzf /root/deploy-$buildId.tar.gz -C /root/app"
Write-Host "  3) 装依赖(只装不构建)  cd /root/app && pnpm install --frozen-lockfile --prod"
Write-Host "  4) 启动  pm2 delete nextjs-app; pm2 start ecosystem.config.js"
Write-Host "  5) 校验  cat .next/BUILD_ID   # 应为 $buildId"
