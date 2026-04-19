#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SIDECAR_ROOT="${CODESYMPHONY_SIDECAR_ROOT:-$HOME/.codesymphony/sidecars}"
readonly SIDECAR_DIR="$SIDECAR_ROOT/ws-scrcpy"
readonly CONFIG_PATH="$SIDECAR_ROOT/ws-scrcpy.config.yaml"

"$SCRIPT_DIR/setup-ws-scrcpy.sh"

cd "$SIDECAR_DIR/dist"
exec env WS_SCRCPY_CONFIG="$CONFIG_PATH" node ./index.js
