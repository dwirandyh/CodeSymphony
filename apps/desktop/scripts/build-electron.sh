#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="${SCRIPT_DIR}/.."
ALLOW_ADHOC_SIGNING="${CODESYMPHONY_ALLOW_ADHOC_SIGNING:-0}"
SIGNING_IDENTITY="${CODESYMPHONY_MACOS_SIGN_IDENTITY:-${APPLE_SIGNING_IDENTITY:-}}"
RESOLVE_SIGNING_IDENTITY_SCRIPT="${SCRIPT_DIR}/resolve-signing-identity.sh"
VERIFY_MACOS_SIGNING_SCRIPT="${SCRIPT_DIR}/verify-macos-signing.sh"
SIGN_MACOS_BINARIES_SCRIPT="${SCRIPT_DIR}/sign-macos-binaries.sh"

builder_args=()
build_app_only=0

for arg in "$@"; do
  case "${arg}" in
    --app|--dir)
      build_app_only=1
      ;;
    *)
      builder_args+=("${arg}")
      ;;
  esac
done

if [[ -n "${SIGNING_IDENTITY}" ]]; then
  export CSC_NAME="${SIGNING_IDENTITY}"
  export CODESYMPHONY_MACOS_SIGN_IDENTITY="${SIGNING_IDENTITY}"
  echo "=== Building Electron bundle with signing identity: ${SIGNING_IDENTITY} ==="
elif [[ "${ALLOW_ADHOC_SIGNING}" == "1" ]]; then
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  export CODESYMPHONY_ALLOW_ADHOC_SIGNING=1
  echo "=== Building Electron bundle without Developer ID signing (local-only) ==="
else
  if SIGNING_IDENTITY="$("${RESOLVE_SIGNING_IDENTITY_SCRIPT}")"; then
    export CSC_NAME="${SIGNING_IDENTITY}"
    export CODESYMPHONY_MACOS_SIGN_IDENTITY="${SIGNING_IDENTITY}"
    echo "=== Building Electron bundle with detected signing identity: ${SIGNING_IDENTITY} ==="
  else
    cat >&2 <<EOF
Missing macOS signing identity.

Set APPLE_SIGNING_IDENTITY or CODESYMPHONY_MACOS_SIGN_IDENTITY to a valid certificate before building release bundles.
If you intentionally want a local unsigned build, set CODESYMPHONY_ALLOW_ADHOC_SIGNING=1.

Available code signing identities:
$(security find-identity -v -p codesigning || true)
EOF
    exit 1
  fi
fi

if [[ -n "${CODESYMPHONY_MACOS_SIGN_IDENTITY:-}" || "${ALLOW_ADHOC_SIGNING}" == "1" ]]; then
  bash "${SIGN_MACOS_BINARIES_SCRIPT}" "${DESKTOP_DIR}/electron/runtime-bundle"
  bash "${SIGN_MACOS_BINARIES_SCRIPT}" "${DESKTOP_DIR}/electron/binaries"
fi

cd "${DESKTOP_DIR}"
rm -rf dist-electron

if [[ "${build_app_only}" == "1" ]]; then
  bun x electron-builder --mac dir ${builder_args[@]+"${builder_args[@]}"}
else
  bun x electron-builder --mac dmg ${builder_args[@]+"${builder_args[@]}"}
fi

if [[ -n "${CODESYMPHONY_MACOS_SIGN_IDENTITY:-}" && "${CODESYMPHONY_MACOS_SIGN_IDENTITY}" != "-" ]]; then
  app_path="$(find dist-electron -type d -name 'CodeSymphony.app' -maxdepth 3 | head -n 1)"
  if [[ -n "${app_path}" ]]; then
    bash "${VERIFY_MACOS_SIGNING_SCRIPT}" "${app_path}" "${CODESYMPHONY_MACOS_SIGN_IDENTITY}"
  fi
fi
