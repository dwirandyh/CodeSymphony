#!/usr/bin/env bash

set -euo pipefail

PORT="5174"
DEV_URL="http://127.0.0.1:${PORT}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  if curl -fsS "${DEV_URL}" | grep -q "<title>CodeSymphony</title>"; then
    echo "Reusing existing CodeSymphony web dev server on :${PORT}"
    exit 0
  fi

  echo "Port ${PORT} is already in use by a different process." >&2
  echo "Stop that process or free the port before running desktop dev." >&2
  exit 1
fi

cd "${WORKSPACE_ROOT}"
bun run --filter @codesymphony/shared-types build
bun run --filter @codesymphony/chat-timeline-core build

cd "${WORKSPACE_ROOT}/apps/web"
exec env VITE_RUNTIME_PORT=4321 bun x vite --port "${PORT}" --strictPort
