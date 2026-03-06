#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}"

# cron 环境通常 PATH 很短，先补一组常见路径。
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

STATE_DIR="${REPO_ROOT}/.codex-runner"
LOG_DIR="${STATE_DIR}/logs"
LOCK_DIR="${STATE_DIR}/lock"
PID_FILE="${LOCK_DIR}/pid"
LOG_FILE="${LOG_DIR}/runner.log"
PROMPT='从todo.md中领取一个未完成的任务对其进行完成，完成后修改其状态'

mkdir -p "${LOG_DIR}"

log() {
  local message="$1"
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "${message}" >> "${LOG_FILE}"
}

cleanup_lock() {
  rm -rf "${LOCK_DIR}"
}

acquire_lock() {
  if mkdir "${LOCK_DIR}" 2>/dev/null; then
    printf '%s\n' "$$" > "${PID_FILE}"
    trap cleanup_lock EXIT INT TERM
    return 0
  fi

  if [[ -f "${PID_FILE}" ]]; then
    local old_pid
    old_pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
    if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" 2>/dev/null; then
      log "检测到已有进程在运行（pid=${old_pid}），本轮跳过。"
      return 1
    fi
  fi

  log "检测到陈旧锁，尝试清理。"
  rm -rf "${LOCK_DIR}"
  if mkdir "${LOCK_DIR}" 2>/dev/null; then
    printf '%s\n' "$$" > "${PID_FILE}"
    trap cleanup_lock EXIT INT TERM
    return 0
  fi

  log "获取锁失败，本轮跳过。"
  return 1
}

find_codex() {
  local candidates=()

  if command -v codex >/dev/null 2>&1; then
    candidates+=("$(command -v codex)")
  fi

  candidates+=(
    "/opt/homebrew/bin/codex"
    "/usr/local/bin/codex"
    "${HOME}/.local/bin/codex"
  )

  local nvm_codex
  nvm_codex="$(ls -1d "${HOME}"/.nvm/versions/node/*/bin/codex 2>/dev/null | sort -V | tail -n 1 || true)"
  if [[ -n "${nvm_codex}" ]]; then
    candidates+=("${nvm_codex}")
  fi

  local candidate candidate_dir
  for candidate in "${candidates[@]}"; do
    if [[ -z "${candidate}" ]] || [[ ! -f "${candidate}" ]]; then
      continue
    fi

    candidate_dir="$(cd "$(dirname "${candidate}")" && pwd)"
    if PATH="${candidate_dir}:${PATH}" "${candidate}" --version >/dev/null 2>&1; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  return 1
}

main() {
  if ! acquire_lock; then
    return 0
  fi

  local codex_bin
  if ! codex_bin="$(find_codex)"; then
    log "未找到 codex 命令，请确认 PATH 或安装位置。"
    return 1
  fi

  # 许多 codex 是 node 脚本，确保其同目录下的 node 可被 /usr/bin/env 找到。
  local codex_dir
  codex_dir="$(cd "$(dirname "${codex_bin}")" && pwd)"
  export PATH="${codex_dir}:${PATH}"

  log "开始执行 codex 任务。"
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    log "DRY_RUN=1，模拟执行：${codex_bin} exec --cd ${REPO_ROOT} --skip-git-repo-check --full-auto --color never \"${PROMPT}\""
    return 0
  fi

  if "${codex_bin}" exec --cd "${REPO_ROOT}" --skip-git-repo-check --full-auto --color never "${PROMPT}" >> "${LOG_FILE}" 2>&1; then
    log "codex 任务执行完成。"
    return 0
  else
    local exit_code=$?
    log "codex 任务执行失败，退出码=${exit_code}。"
    return "${exit_code}"
  fi
}

main "$@"
