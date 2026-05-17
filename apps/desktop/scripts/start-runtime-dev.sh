#!/usr/bin/env bash

set -euo pipefail

PORT="${RUNTIME_PORT:-4321}"
HEALTH_URL="http://127.0.0.1:${PORT}/health"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
RUNTIME_DIR="${WORKSPACE_ROOT}/apps/runtime"

if curl -fsS --max-time 1 "${HEALTH_URL}" | grep -q '{"ok":true}'; then
  echo "Reusing existing CodeSymphony runtime on :${PORT}"
  exit 0
fi

if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  existing_pid="$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN | head -n 1)"
  existing_pgid="$(ps -o pgid= -p "${existing_pid}" 2>/dev/null | tr -d '[:space:]')"
  existing_command="$(ps -ww -p "${existing_pid}" -o command= 2>/dev/null || true)"
  existing_cwd="$(lsof -a -p "${existing_pid}" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"

  if [[ "${existing_cwd}" == "${RUNTIME_DIR}" ]] \
    || [[ "${existing_command}" == *"@codesymphony/runtime"* ]] \
    || [[ "${existing_command}" == *"src/index.ts"* ]] \
    || [[ "${existing_command}" == *"desktop.dev.db"* ]]; then
    echo "Stopping stale CodeSymphony runtime on :${PORT} (pid ${existing_pid}, pgid ${existing_pgid:-unknown})"
    if [[ -n "${existing_pgid}" ]]; then
      kill -TERM -- "-${existing_pgid}" 2>/dev/null || true
    else
      kill "${existing_pid}" 2>/dev/null || true
    fi

    for _ in {1..20}; do
      if ! lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
        break
      fi
      sleep 0.25
    done

    if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
      if [[ -n "${existing_pgid}" ]]; then
        kill -KILL -- "-${existing_pgid}" 2>/dev/null || true
      else
        kill -KILL "${existing_pid}" 2>/dev/null || true
      fi
    fi

    for _ in {1..20}; do
      if ! lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
        break
      fi
      sleep 0.25
    done

    if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "Unable to free port ${PORT} after stopping the stale CodeSymphony runtime." >&2
      exit 1
    fi
  else
    echo "Port ${PORT} is already in use by a different process." >&2
    exit 1
  fi
fi

exec pnpm --filter @codesymphony/runtime dev
