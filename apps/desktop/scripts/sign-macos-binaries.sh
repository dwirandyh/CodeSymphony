#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_PATH="${1:-}"
SIGNING_IDENTITY="${CODESYMPHONY_MACOS_SIGN_IDENTITY:-${APPLE_SIGNING_IDENTITY:-}}"
ALLOW_ADHOC_SIGNING="${CODESYMPHONY_ALLOW_ADHOC_SIGNING:-0}"
NODE_ENTITLEMENTS="${SCRIPT_DIR}/../src-tauri/entitlements/node.plist"
SIMULATOR_BRIDGE_ENTITLEMENTS="${SCRIPT_DIR}/../src-tauri/entitlements/simulator-bridge.plist"

if [[ -z "${TARGET_PATH}" ]]; then
  echo "Usage: $0 <target-path>" >&2
  exit 1
fi

if [[ ! -e "${TARGET_PATH}" ]]; then
  echo "Target path not found: ${TARGET_PATH}" >&2
  exit 1
fi

if [[ -z "${SIGNING_IDENTITY}" ]]; then
  if [[ "${ALLOW_ADHOC_SIGNING}" == "1" ]]; then
    SIGNING_IDENTITY="-"
  else
    echo "Skipping nested macOS binary signing for ${TARGET_PATH}; no signing identity was provided."
    exit 0
  fi
fi

sign_macho() {
  local path="$1"
  local filename
  local entitlements_path=""
  local -a sign_args

  if ! file -b "${path}" | grep -q "Mach-O"; then
    return 0
  fi

  sign_args=(codesign --force --sign "${SIGNING_IDENTITY}")

  if [[ "${SIGNING_IDENTITY}" != "-" ]]; then
    sign_args+=(--options runtime)
  fi

  filename="$(basename "${path}")"
  if [[ "${filename}" == "node" || "${filename}" == node-* ]]; then
    entitlements_path="${NODE_ENTITLEMENTS}"
  elif [[ "${filename}" == "SimulatorBridge" ]]; then
    entitlements_path="${SIMULATOR_BRIDGE_ENTITLEMENTS}"
  fi

  if [[ -n "${entitlements_path}" ]]; then
    sign_args+=(--entitlements "${entitlements_path}")
  fi

  echo "Signing nested Mach-O: ${path}"
  "${sign_args[@]}" "${path}"
}

if [[ -f "${TARGET_PATH}" ]]; then
  sign_macho "${TARGET_PATH}"
  exit 0
fi

while IFS= read -r -d '' path; do
  sign_macho "${path}"
done < <(find "${TARGET_PATH}" -type f \( -perm -111 -o -name "*.node" -o -name "*.dylib" -o -name "SimulatorBridge" \) -print0)
