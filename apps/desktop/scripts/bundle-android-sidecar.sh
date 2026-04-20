#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="${SCRIPT_DIR}/.."
WORKSPACE_ROOT="${DESKTOP_DIR}/../.."
TARGET_DIR="${1:-${DESKTOP_DIR}/src-tauri/runtime-bundle/android-ws-scrcpy}"
SIDECAR_ROOT="${CODESYMPHONY_SIDECAR_ROOT:-$HOME/.codesymphony/sidecars}"
SIDECAR_DIR="${SIDECAR_ROOT}/ws-scrcpy"
ANDROID_PORT="${ANDROID_WS_SCRCPY_PORT:-8765}"

"${WORKSPACE_ROOT}/scripts/setup-ws-scrcpy.sh"

if [[ ! -d "${SIDECAR_DIR}/dist/node_modules" ]]; then
  echo "Missing standalone ws-scrcpy dist dependencies at ${SIDECAR_DIR}/dist/node_modules" >&2
  exit 1
fi

rm -rf "${TARGET_DIR}"
mkdir -p "${TARGET_DIR}"

cp -R "${SIDECAR_DIR}/dist" "${TARGET_DIR}/dist"

cat >"${TARGET_DIR}/ws-scrcpy.config.yaml" <<EOF
server:
  - secure: false
    port: ${ANDROID_PORT}
EOF

echo "=== Android ws-scrcpy bundle ready at ${TARGET_DIR} ==="
