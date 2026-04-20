#!/usr/bin/env bash
set -euo pipefail

readonly UPSTREAM_URL="https://github.com/NetrisTV/ws-scrcpy.git"
readonly UPSTREAM_COMMIT="49d26231840cafcde77a3e778b804d8af498a5ac"
readonly SIDECAR_ROOT="${CODESYMPHONY_SIDECAR_ROOT:-$HOME/.codesymphony/sidecars}"
readonly SIDECAR_DIR="$SIDECAR_ROOT/ws-scrcpy"
readonly BUILD_STAMP_PATH="$SIDECAR_DIR/.codesymphony-build"
readonly CONFIG_PATH="$SIDECAR_ROOT/ws-scrcpy.config.yaml"
readonly ANDROID_PORT="${ANDROID_WS_SCRCPY_PORT:-8765}"

require_command() {
  local command_name="$1"

  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
}

write_node_pty_stub() {
  mkdir -p "$SIDECAR_DIR/typings"

  cat >"$SIDECAR_DIR/typings/node-pty.d.ts" <<'EOF'
declare module "node-pty" {
  export interface IPty {
    on(event: string, listener: (...args: any[]) => void): void;
    write(data: string): void;
    kill(): void;
  }

  export function spawn(file: string, args: string[], options?: Record<string, unknown>): IPty;
}
EOF
}

patch_package_json() {
  node - "$SIDECAR_DIR/package.json" <<'EOF'
const fs = require("node:fs");

const packageJsonPath = process.argv[2];
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

if (packageJson.dependencies && Object.hasOwn(packageJson.dependencies, "node-pty")) {
  delete packageJson.dependencies["node-pty"];
}

fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
EOF
}

write_build_override() {
  cat >"$SIDECAR_DIR/build.config.override.json" <<'EOF'
{
  "INCLUDE_ADB_SHELL": false,
  "INCLUDE_DEV_TOOLS": false,
  "INCLUDE_FILE_LISTING": false,
  "INCLUDE_APPL": false,
  "INCLUDE_GOOG": true,
  "USE_WEBCODECS": true,
  "USE_BROADWAY": false,
  "USE_H264_CONVERTER": false,
  "USE_TINY_H264": false,
  "USE_WDA_MJPEG_SERVER": false,
  "USE_QVH_SERVER": false,
  "SCRCPY_LISTENS_ON_ALL_INTERFACES": true,
  "PATHNAME": "/"
}
EOF
}

write_runtime_config() {
  mkdir -p "$SIDECAR_ROOT"

  cat >"$CONFIG_PATH" <<EOF
server:
  - secure: false
    port: $ANDROID_PORT
EOF
}

ensure_dist_runtime_dependencies() {
  if [[ ! -f "$SIDECAR_DIR/dist/package.json" ]]; then
    echo "ws-scrcpy dist package.json is missing. Re-run the setup." >&2
    exit 1
  fi

  if [[ -d "$SIDECAR_DIR/dist/node_modules" ]]; then
    return
  fi

  (
    cd "$SIDECAR_DIR/dist"
    npm install --omit=dev --no-audit --no-fund
  )
}

ensure_checkout() {
  mkdir -p "$SIDECAR_ROOT"

  if [[ ! -d "$SIDECAR_DIR/.git" ]]; then
    git clone "$UPSTREAM_URL" "$SIDECAR_DIR"
    git -C "$SIDECAR_DIR" fetch --depth 1 origin "$UPSTREAM_COMMIT"
    git -C "$SIDECAR_DIR" checkout --force "$UPSTREAM_COMMIT"
    return
  fi

  local current_commit
  current_commit="$(git -C "$SIDECAR_DIR" rev-parse HEAD 2>/dev/null || true)"
  if [[ "$current_commit" != "$UPSTREAM_COMMIT" ]]; then
    git -C "$SIDECAR_DIR" fetch --depth 1 origin "$UPSTREAM_COMMIT"
    git -C "$SIDECAR_DIR" checkout --force "$UPSTREAM_COMMIT"
  fi
}

needs_rebuild() {
  if [[ ! -d "$SIDECAR_DIR/node_modules" ]]; then
    return 0
  fi

  if [[ ! -f "$SIDECAR_DIR/dist/index.js" ]]; then
    return 0
  fi

  if [[ ! -f "$BUILD_STAMP_PATH" ]]; then
    return 0
  fi

  local built_commit
  built_commit="$(cat "$BUILD_STAMP_PATH")"
  [[ "$built_commit" != "$UPSTREAM_COMMIT" ]]
}

main() {
  require_command git
  require_command node
  require_command npm
  require_command adb

  ensure_checkout
  write_build_override
  write_node_pty_stub
  patch_package_json
  write_runtime_config

  if needs_rebuild; then
    (
      cd "$SIDECAR_DIR"
      npm install --no-audit --no-fund
      npm run dist
    )
    printf '%s\n' "$UPSTREAM_COMMIT" >"$BUILD_STAMP_PATH"
  fi

  ensure_dist_runtime_dependencies

  printf 'ws-scrcpy ready at %s\n' "$SIDECAR_DIR"
  printf 'config: %s\n' "$CONFIG_PATH"
}

main "$@"
