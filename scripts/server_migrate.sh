#!/usr/bin/env bash
# ============================================================
# ClusterInte-lligence 服务器端辅助脚本
#
# 背景（2026-09-18 安全整改）：
#   真实网络数据（拓扑 JSON / 资产全景 CSV）与 Neo4j 凭据已全部移出 git 仓库，
#   仓库历史也被重写。因此：
#     • 服务器上的旧 clone 无法再推送，需要一次性迁移到新历史
#     • 在服务器构建时，需要把真实数据放回 public/（构建产物要用），
#       并准备好 .env.local（含 NEXT_PUBLIC_MONITOR_IPS，构建时注入）
#
# 用法：
#   bash scripts/server_migrate.sh              # 一次性迁移（重新 clone + 恢复数据 + 建 .env.local）
#   bash scripts/server_migrate.sh prepare      # 每次「服务器构建」前执行
#   bash scripts/server_migrate.sh check        # 只体检，不改动任何东西
#   bash scripts/server_migrate.sh backup       # 只把真实数据与 .env.local 备份到仓库外
#
# 环境变量（可选）：
#   REPO_URL          仓库地址，默认 https://github.com/HLIU5F/ClusterInte-lligence-2.0.git
#   TOPO_BACKUP_DIR   真实数据备份目录，默认 $HOME/topo_backup
#   BRANCH            分支名，默认 main
#
# 本脚本不含任何真实 IP 与密码，可安全提交入库。
# ============================================================
set -Eeuo pipefail

REPO_URL="${REPO_URL:-https://github.com/HLIU5F/ClusterInte-lligence-2.0.git}"
BACKUP_DIR="${TOPO_BACKUP_DIR:-$HOME/topo_backup}"
BRANCH="${BRANCH:-main}"

DATA_FILES=(
  topology_data_core.json
  topology_data_purified.json
  topology_data_security.json
  topology_data_security_enhanced.json
  topology_for_frontend.json
  security_zones_export.csv
)

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[警告] %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m[OK] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[错误] %s\033[0m\n' "$*" >&2; exit 1; }

repo_root() { git rev-parse --show-toplevel 2>/dev/null || die "当前目录不是 git 仓库，请在项目根目录执行"; }

# ---------- 备份真实数据与 .env.local 到仓库外 ----------
do_backup() {
  mkdir -p "$BACKUP_DIR"
  local n=0
  for f in "${DATA_FILES[@]}"; do
    if [[ -f "public/$f" ]]; then
      cp -f "public/$f" "$BACKUP_DIR/$f"
      n=$((n + 1))
    elif [[ -f "$f" ]]; then
      cp -f "$f" "$BACKUP_DIR/$f"
      n=$((n + 1))
    fi
  done
  if [[ -f .env.local ]]; then
    cp -f .env.local "$BACKUP_DIR/.env.local"
    n=$((n + 1))
  fi
  echo "  已备份 $n 个文件到 $BACKUP_DIR"
}

# ---------- 从仓库外备份恢复数据文件到 public/ ----------
do_restore_data() {
  mkdir -p public
  local n=0
  for f in "${DATA_FILES[@]}"; do
    if [[ -f "$BACKUP_DIR/$f" ]]; then
      cp -f "$BACKUP_DIR/$f" "public/$f"
      n=$((n + 1))
    fi
  done
  echo "  已恢复 $n/${#DATA_FILES[@]} 个数据文件到 public/（已被 .gitignore 忽略，不会被提交）"
  if [[ $n -eq 0 ]]; then
    warn "未找到可恢复的数据文件 → 构建后「业务核心图」会加载 public/topology_demo.json（合成演示数据）"
  fi
}

# ---------- 保证 .env.local 存在且关键项已填 ----------
do_ensure_env() {
  if [[ ! -f .env.local && -f "$BACKUP_DIR/.env.local" ]]; then
    cp -f "$BACKUP_DIR/.env.local" .env.local
    chmod 600 .env.local 2>/dev/null || true
    echo "  已从 $BACKUP_DIR 恢复 .env.local"
  fi
  if [[ ! -f .env.local ]]; then
    cat > .env.local <<'ENVEOF'
# 由 scripts/server_migrate.sh 生成 —— 请填写真实值
# 本文件已被 .gitignore 忽略，不会进入任何提交
NEO4J_HTTP_URL=http://localhost:7474
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=CHANGE_ME
NEO4J_DB=neo4j
NEO4J_DATABASE=neo4j
PYTHON_BIN=python3
MONITOR_IPS=CHANGE_ME
NEXT_PUBLIC_MONITOR_IPS=CHANGE_ME
PORT=5000
HOSTNAME=localhost
ENVEOF
    chmod 600 .env.local 2>/dev/null || true
    warn "已生成 .env.local 模板 → 请填写 NEO4J_PASSWORD 与 MONITOR_IPS（真实采集节点 IP，逗号分隔）"
  else
    echo "  .env.local 已存在"
  fi
  if grep -q '^NEO4J_PASSWORD=CHANGE_ME' .env.local 2>/dev/null; then
    warn "NEO4J_PASSWORD 仍是占位值 → scripts/ 下的导入脚本会报「缺少 NEO4J_PASSWORD」"
  fi
  if grep -q '^NEXT_PUBLIC_MONITOR_IPS=CHANGE_ME' .env.local 2>/dev/null; then
    warn "NEXT_PUBLIC_MONITOR_IPS 仍是占位值 → 构建后采集/汇聚节点不会被识别为核心基础设施"
  fi
  return 0
}

# ---------- 体检 ----------
do_check() {
  log "git 状态"
  git log --oneline -1
  if git rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1; then
    echo "  与 origin/$BRANCH 的领先/落后: $(git rev-list --left-right --count "HEAD...origin/$BRANCH")"
  else
    warn "找不到 origin/$BRANCH（可能需要 git fetch）"
  fi

  log "真实数据是否已脱离 git 跟踪"
  if git ls-files | grep -qE 'public/topology_data|asset_panorama|security_zones_export'; then
    warn "仍有真实数据被 git 跟踪 → 请执行： bash scripts/server_migrate.sh migrate"
  else
    ok "真实数据文件未被 git 跟踪"
  fi

  log "本地环境与数据"
  if [[ -f .env.local ]]; then ok ".env.local 存在"; else warn ".env.local 缺失 → 脚本与 Neo4j 接口会报错"; fi
  local n=0
  for f in "${DATA_FILES[@]}"; do
    if [[ -f "public/$f" ]]; then
      n=$((n + 1))
    fi
  done
  echo "  public/ 中的真实数据文件: $n / ${#DATA_FILES[@]}"
  if [[ $n -eq 0 ]]; then
    warn "public/ 无真实数据 → 构建产物会显示合成演示数据（192.0.2.x 等）"
  fi
  if [[ -d "$BACKUP_DIR" ]]; then
    echo "  仓库外备份目录 $BACKUP_DIR 中有 $(find "$BACKUP_DIR" -maxdepth 1 -type f | wc -l) 个文件"
  else
    warn "仓库外备份目录 $BACKUP_DIR 不存在 → 建议先执行 backup"
  fi
}

# ---------- 一次性迁移 ----------
do_migrate() {
  local root; root="$(repo_root)"
  cd "$root"

  log "0/5 迁移前检查"
  if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    warn "存在未提交的改动，迁移会切换目录，请先确认这些改动已处理："
    git status --short
    printf '\n  已完成处理并继续？(y/N) '
    local ans=""; read -r ans || true
    [[ "${ans:-N}" =~ ^[Yy]$ ]] || die "已中止。建议：git log origin/$BRANCH..HEAD --oneline && git format-patch origin/$BRANCH..HEAD -o ~/patches"
  fi

  log "1/5 备份真实数据与 .env.local"
  do_backup

  log "2/5 导出未推送的提交（若有）"
  local patches="$HOME/patches"
  if git rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1 && [[ -n "$(git log "origin/$BRANCH..HEAD" --oneline 2>/dev/null)" ]]; then
    mkdir -p "$patches"
    git format-patch "origin/$BRANCH..HEAD" -o "$patches" >/dev/null
    echo "  已导出到 $patches → 重新 clone 后用 git am 应用"
  else
    echo "  无未推送提交"
  fi

  log "3/5 重新 clone 干净仓库"
  local parent name stamp
  parent="$(dirname "$root")"; name="$(basename "$root")"; stamp="$(date +%Y%m%d%H%M%S)"
  cd "$parent"
  if [[ -d "$name" ]]; then mv "$name" "${name}.old.${stamp}"; fi
  if ! git clone "$REPO_URL" "$name"; then
    warn "clone 失败，正在还原原目录"
    if [[ -d "$name" ]]; then rm -rf "$name"; fi
    mv "${name}.old.${stamp}" "$name"
    die "clone 失败，已还原原目录。请检查网络与权限后重试"
  fi
  cd "$name"

  log "4/5 恢复 .env.local 与真实数据"
  if [[ -f "$BACKUP_DIR/.env.local" ]]; then
    cp -f "$BACKUP_DIR/.env.local" .env.local
    chmod 600 .env.local 2>/dev/null || true
    echo "  已恢复 .env.local"
  fi
  do_ensure_env
  do_restore_data

  log "5/5 迁移完成，当前状态"
  do_check
  cat <<'TIP'

后续操作：
  • 应用之前导出的改动：      git am ~/patches/*.patch
  • 日常提交推送：            git add -A && git commit -m "..." && git push origin main
  • 服务器构建（内存不够时）：先 bash scripts/server_migrate.sh prepare 再 bash ./scripts/build.sh
  • 本地构建：               直接把备份里的真实数据留在本地 public/ 即可，无需本脚本

两条红线：
  🚫 不要执行 git push --force        （会把含真实数据与密码的旧历史重新推回远端）
  🚫 不要执行 git clean -fdx / git reset --hard
                                      （会物理删除 public/ 里已不再被 git 跟踪的数据文件）
TIP
}

# ---------- 入口 ----------
main() {
  local mode="${1:-}"
  case "$mode" in
    migrate)
      do_migrate
      ;;
    prepare)
      log "构建前准备"
      do_ensure_env
      do_restore_data
      do_check
      ;;
    check)
      do_check
      ;;
    backup)
      log "备份真实数据到仓库外"
      do_backup
      ;;
    ""|-h|--help|help)
      # 无参数时只打印用法（不执行任何改动），避免误触迁移
      sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
      echo "（未执行任何操作；要迁移请显式执行： bash scripts/server_migrate.sh migrate）"
      ;;
    *)
      die "未知参数：$mode（可用：migrate / prepare / check / backup）"
      ;;
  esac
}

main "$@"
