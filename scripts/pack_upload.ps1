<#
.SYNOPSIS
  Build locally and pack the upload artifact for the Linux server.

.DESCRIPTION
  Upload list (see DEPLOY.md):
    .next (cache/dev/standalone/turbopack/diagnostics pruned)
    dist/server.js, public/, scripts/
    package.json, pnpm-lock.yaml, .npmrc, next.config.ts, tsconfig.json,
    postcss.config.mjs, components.json, ecosystem.config.js, .env.example, neo4j.conf
    DEPLOY.md

  node_modules is never packed: the local tree holds win32 binaries
  (@next/swc-win32-x64-msvc, @img/sharp-win32-x64) and would fail on Linux.
  .env.local is never packed: it holds the Neo4j password.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/pack_upload.ps1
  powershell -ExecutionPolicy Bypass -File scripts/pack_upload.ps1 -SkipBuild
#>
param(
  [switch]$SkipBuild,
  [string]$OutDir = [Environment]::GetFolderPath('Desktop'),
  [string]$Name = 'cluster-intelligence-build.tar.gz'
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

# ---------------------------------------------------------------- 1. build
Write-Host "`n=== 1/6 build ===" -ForegroundColor Cyan
if ($SkipBuild) {
  Write-Host '  skipped (-SkipBuild)'
} else {
  $env:NODE_OPTIONS = ''
  & node node_modules/next/dist/bin/next build --webpack
  if ($LASTEXITCODE -ne 0) { throw 'next build failed' }

  & node node_modules/tsup/dist/cli-default.js src/server.ts --format cjs --platform node --target node20 --outDir dist --no-splitting --no-minify 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'tsup failed (dist/server.js)' }
  Write-Host '  + .next built, dist/server.js rebuilt'
}

if (-not (Test-Path '.next\BUILD_ID')) { throw '.next/BUILD_ID missing - build first' }
$buildId = (Get-Content '.next\BUILD_ID' -Raw).Trim()
Write-Host "  BUILD_ID = $buildId"

# ------------------------------------------------------------ 2. staging
Write-Host "`n=== 2/6 staging ===" -ForegroundColor Cyan
$stage = Join-Path $env:TEMP ("ci-upload-stage-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $stage -Force | Out-Null

Copy-Item '.next' (Join-Path $stage '.next') -Recurse -Force
foreach ($junk in @('cache', 'dev', 'standalone', 'turbopack', 'diagnostics')) {
  $p = Join-Path $stage ".next\$junk"
  if (Test-Path $p) {
    Remove-Item $p -Recurse -Force
    Write-Host "  - drop .next/$junk"
  }
}
Write-Host ("  + .next/  {0} MB" -f (Get-SizeMB (Join-Path $stage '.next')))

Copy-Item 'dist' (Join-Path $stage 'dist') -Recurse -Force
Write-Host ("  + dist/  {0} MB" -f (Get-SizeMB (Join-Path $stage 'dist')))

Copy-Item 'public' (Join-Path $stage 'public') -Recurse -Force
Get-ChildItem (Join-Path $stage 'public') -File | Where-Object { $_.Name -match '\.bak$|\.v1\.bak$' } | ForEach-Object {
  Write-Host "  - drop public/$($_.Name)"
  Remove-Item $_.FullName -Force
}
Write-Host ("  + public/  {0} MB" -f (Get-SizeMB (Join-Path $stage 'public')))

if (Test-Path 'scripts') {
  Copy-Item 'scripts' (Join-Path $stage 'scripts') -Recurse -Force
  foreach ($junk in @('.venv', '__pycache__', 'enrichers\__pycache__')) {
    $p2 = Join-Path $stage "scripts\$junk"
    if (Test-Path $p2) { Remove-Item $p2 -Recurse -Force }
  }
  Get-ChildItem (Join-Path $stage 'scripts') -Recurse -File -Include *.pyc -ErrorAction SilentlyContinue | Remove-Item -Force
  Write-Host ("  + scripts/  {0} MB" -f (Get-SizeMB (Join-Path $stage 'scripts')))
}

# ------------------------------------------------------------ 3. config files
Write-Host "`n=== 3/6 config files ===" -ForegroundColor Cyan
$files = @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'next.config.ts', 'tsconfig.json',
           'postcss.config.mjs', 'components.json', 'ecosystem.config.js',
           '.env.example', 'neo4j.conf')
$copied = @()
foreach ($f in $files) {
  if (Test-Path $f) { Copy-Item $f $stage -Force; $copied += $f }
}
Write-Host ("  + {0}: {1}" -f $copied.Count, ($copied -join ', '))
if (Test-Path '.env.local') { Write-Host '  ! .env.local excluded on purpose (holds password)' -ForegroundColor Yellow }

# ------------------------------------------------------------ 4. DEPLOY.md
Write-Host "`n=== 4/6 DEPLOY.md ===" -ForegroundColor Cyan
$stamp = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
$tpl = Join-Path $root 'docs\DEPLOY_TEMPLATE.md'
if (-not (Test-Path $tpl)) { throw 'docs/DEPLOY_TEMPLATE.md missing' }
$doc = [System.IO.File]::ReadAllText($tpl, [System.Text.Encoding]::UTF8)
$doc = $doc.Replace('__BUILD_ID__', $buildId).Replace('__STAMP__', $stamp)
[System.IO.File]::WriteAllText((Join-Path $stage 'DEPLOY.md'), $doc, (New-Object System.Text.UTF8Encoding($false)))
Write-Host '  + DEPLOY.md'

# ------------------------------------------------------------ 5. tar
Write-Host "`n=== 5/6 tar ===" -ForegroundColor Cyan
Write-Host ("  staging size: {0} MB" -f (Get-SizeMB $stage))
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$tarball = Join-Path $OutDir $Name
if (Test-Path $tarball) { Remove-Item $tarball -Force }
& tar -czf $tarball -C $stage .
if ($LASTEXITCODE -ne 0) { throw 'tar failed' }
Write-Host ("  -> {0}  ({1} MB)" -f $tarball, (Get-SizeMB $tarball))

# ------------------------------------------------------------ 6. verify
Write-Host "`n=== 6/6 verify ===" -ForegroundColor Cyan
$entries = & tar -tzf $tarball
Write-Host ("  entries: {0}" -f $entries.Count)
foreach ($need in @('./.next/BUILD_ID', './dist/server.js', './public/topology_for_frontend_new2.0.json',
                    './package.json', './pnpm-lock.yaml', './next.config.ts', './ecosystem.config.js', './DEPLOY.md')) {
  if ($entries -contains $need) { Write-Host "  OK       $need" -ForegroundColor Green }
  else { Write-Host "  MISSING  $need" -ForegroundColor Red }
}
if ($entries -contains './.env.local') { throw '.env.local leaked into the package' }
Remove-Item $stage -Recurse -Force

Write-Host "`nDone: $tarball" -ForegroundColor Green
Write-Host "Upload: scp `"$tarball`" root@<server>:/root/"
