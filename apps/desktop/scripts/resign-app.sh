#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="${SCRIPT_DIR}/.."
APP_PATH="${DESKTOP_DIR}/src-tauri/target/release/bundle/macos/CodeSymphony.app"
SIGNING_IDENTITY="${CODESYMPHONY_MACOS_SIGN_IDENTITY:-${APPLE_SIGNING_IDENTITY:-}}"
ALLOW_ADHOC_SIGNING="${CODESYMPHONY_ALLOW_ADHOC_SIGNING:-0}"
SIGN_MACOS_BINARIES_SCRIPT="${SCRIPT_DIR}/sign-macos-binaries.sh"
RUNTIME_BUNDLE_DIR="${APP_PATH}/Contents/Resources/runtime-bundle"
APP_MACOS_DIR="${APP_PATH}/Contents/MacOS"

if [[ ! -d "${APP_PATH}" ]]; then
  echo "App bundle not found: ${APP_PATH}" >&2
  exit 1
fi

if [[ -z "${SIGNING_IDENTITY}" ]]; then
  if [[ "${ALLOW_ADHOC_SIGNING}" == "1" ]]; then
    SIGNING_IDENTITY="-"
  else
    cat >&2 <<EOF
Missing macOS signing identity.

Set APPLE_SIGNING_IDENTITY or CODESYMPHONY_MACOS_SIGN_IDENTITY to a valid certificate before signing release builds.
Ad-hoc signing breaks TCC-sensitive features like Screen Recording for the packaged app.
If you intentionally want an ad-hoc local build, set CODESYMPHONY_ALLOW_ADHOC_SIGNING=1.
EOF
    exit 1
  fi
fi

echo "=== Re-signing ${APP_PATH} ==="
if [[ -d "${RUNTIME_BUNDLE_DIR}" ]]; then
  bash "${SIGN_MACOS_BINARIES_SCRIPT}" "${RUNTIME_BUNDLE_DIR}"
fi
if [[ -d "${APP_MACOS_DIR}" ]]; then
  while IFS= read -r -d '' path; do
    bash "${SIGN_MACOS_BINARIES_SCRIPT}" "${path}"
  done < <(find "${APP_MACOS_DIR}" -maxdepth 1 -type f \( -name "node" -o -name "node-*" \) -print0)
fi
if [[ "${SIGNING_IDENTITY}" == "-" ]]; then
  codesign --force --sign "${SIGNING_IDENTITY}" "${APP_PATH}"
else
  codesign --force --options runtime --sign "${SIGNING_IDENTITY}" "${APP_PATH}"
fi
codesign --verify --deep --strict --verbose=2 "${APP_PATH}"
