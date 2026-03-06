#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}"
CRON_SCRIPT="${REPO_ROOT}/codex-cron.sh"
STATE_DIR="${REPO_ROOT}/.codex-runner"
LOCK_DIR="${STATE_DIR}/lock"
PID_FILE="${LOCK_DIR}/pid"
CRON_EXPR="* * * * * ${CRON_SCRIPT}"

ensure_cron_script() {
  if [[ ! -f "${CRON_SCRIPT}" ]]; then
    echo "未找到脚本: ${CRON_SCRIPT}"
    exit 1
  fi
  chmod +x "${CRON_SCRIPT}"
}

read_crontab() {
  crontab -l 2>/dev/null || true
}

start_runner() {
  ensure_cron_script

  local current
  current="$(read_crontab)"
  if printf '%s\n' "${current}" | grep -F -q "${CRON_SCRIPT}"; then
    echo "定时任务已存在，无需重复添加。"
    return 0
  fi

  {
    printf '%s\n' "${current}"
    printf '%s\n' "${CRON_EXPR}"
  } | awk 'NF' | crontab -

  echo "已启动：每分钟执行一次 ${CRON_SCRIPT}"
}

kill_runner() {
  local current filtered
  current="$(read_crontab)"
  filtered="$(printf '%s\n' "${current}" | grep -F -v "${CRON_SCRIPT}" || true)"
  printf '%s\n' "${filtered}" | awk 'NF' | crontab -
  echo "已移除 cron 定时任务（如果存在）。"

  if [[ -f "${PID_FILE}" ]]; then
    local pid
    pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      kill "${pid}" 2>/dev/null || true
      echo "已终止运行中的任务进程（pid=${pid}）。"
    else
      echo "锁文件中的进程不存在，跳过终止。"
    fi
  else
    echo "未检测到锁文件，无运行中任务。"
  fi

  rm -rf "${LOCK_DIR}"
  echo "已清理锁目录。"
}

status_runner() {
  local current
  current="$(read_crontab)"
  if printf '%s\n' "${current}" | grep -F -q "${CRON_SCRIPT}"; then
    echo "cron: 已启用"
  else
    echo "cron: 未启用"
  fi

  if [[ -f "${PID_FILE}" ]]; then
    local pid
    pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      echo "process: 运行中（pid=${pid}）"
    else
      echo "process: 锁存在但进程不在（陈旧锁）"
    fi
  else
    echo "process: 未运行"
  fi
}

usage() {
  cat <<'EOF'
用法:
  ./codex-runnerctl.sh start   一键启动（添加每分钟 cron）
  ./codex-runnerctl.sh kill    一键停止（移除 cron + 杀进程 + 清锁）
  ./codex-runnerctl.sh status  查看状态
EOF
}

main() {
  local action="${1:-}"
  case "${action}" in
    start)
      start_runner
      ;;
    kill)
      kill_runner
      ;;
    status)
      status_runner
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
