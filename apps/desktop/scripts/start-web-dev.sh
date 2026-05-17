#!/usr/bin/env bash

set -euo pipefail

PORT="5174"
DEV_URL="http://127.0.0.1:${PORT}"

if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  if curl -fsS "${DEV_URL}" | grep -q "<title>CodeSymphony</title>"; then
    echo "Reusing existing CodeSymphony web dev server on :${PORT}"
    exit 0
  fi

  echo "Port ${PORT} is already in use by a different process." >&2
  echo "Stop that process or free the port before running desktop dev." >&2
  exit 1
fi

exec pnpm --filter @codesymphony/web exec vite --port "${PORT}" --strictPort
