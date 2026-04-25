#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="${SCRIPT_DIR}/.."
ALLOW_ADHOC_SIGNING="${CODESYMPHONY_ALLOW_ADHOC_SIGNING:-0}"
SIGNING_IDENTITY="${CODESYMPHONY_MACOS_SIGN_IDENTITY:-${APPLE_SIGNING_IDENTITY:-}}"
RESIGN_APP_SCRIPT="${SCRIPT_DIR}/resign-app.sh"
PACKAGE_DMG_SCRIPT="${SCRIPT_DIR}/package-dmg.sh"
RESOLVE_SIGNING_IDENTITY_SCRIPT="${SCRIPT_DIR}/resolve-signing-identity.sh"
VERIFY_MACOS_SIGNING_SCRIPT="${SCRIPT_DIR}/verify-macos-signing.sh"
APP_PATH="${DESKTOP_DIR}/src-tauri/target/release/bundle/macos/CodeSymphony.app"

should_package_dmg=1
next_is_bundle_arg=0
tauri_build_args=()

for arg in "$@"; do
  if [[ "${next_is_bundle_arg}" == "1" ]]; then
    next_is_bundle_arg=0
    if [[ "${arg}" != *"dmg"* && "${arg}" != *"all"* ]]; then
      should_package_dmg=0
    fi
    continue
  fi

  case "${arg}" in
    -b|--bundles)
      next_is_bundle_arg=1
      ;;
  esac
done

if [[ "${should_package_dmg}" == "1" ]]; then
  skip_next_arg=0
  for arg in "$@"; do
    if [[ "${skip_next_arg}" == "1" ]]; then
      skip_next_arg=0
      continue
    fi

    case "${arg}" in
      -b|--bundles)
        skip_next_arg=1
        ;;
      *)
        tauri_build_args+=("${arg}")
        ;;
    esac
  done
  tauri_build_args+=("-b" "app")
else
  tauri_build_args=("$@")
fi

if [[ -n "${SIGNING_IDENTITY}" ]]; then
  export APPLE_SIGNING_IDENTITY="${SIGNING_IDENTITY}"
  export CODESYMPHONY_MACOS_SIGN_IDENTITY="${SIGNING_IDENTITY}"
  echo "=== Building Tauri bundle with signing identity: ${APPLE_SIGNING_IDENTITY} ==="
elif [[ "${ALLOW_ADHOC_SIGNING}" == "1" ]]; then
  export APPLE_SIGNING_IDENTITY="-"
  export CODESYMPHONY_MACOS_SIGN_IDENTITY="-"
  echo "=== Building Tauri bundle with ad-hoc signing (local-only) ==="
else
  if SIGNING_IDENTITY="$("${RESOLVE_SIGNING_IDENTITY_SCRIPT}")"; then
    export APPLE_SIGNING_IDENTITY="${SIGNING_IDENTITY}"
    export CODESYMPHONY_MACOS_SIGN_IDENTITY="${SIGNING_IDENTITY}"
    echo "=== Building Tauri bundle with detected signing identity: ${APPLE_SIGNING_IDENTITY} ==="
  else
    cat >&2 <<EOF
Missing macOS signing identity.

Set APPLE_SIGNING_IDENTITY or CODESYMPHONY_MACOS_SIGN_IDENTITY to a valid certificate before building release bundles.
TCC-sensitive features like Screen Recording are unreliable with ad-hoc signing.
If you intentionally want an ad-hoc local build, set CODESYMPHONY_ALLOW_ADHOC_SIGNING=1.

Available code signing identities:
$(security find-identity -v -p codesigning || true)
EOF
    exit 1
  fi
fi

cd "${DESKTOP_DIR}"
pnpm exec tauri build "${tauri_build_args[@]}"
bash "${RESIGN_APP_SCRIPT}"

if [[ "${APPLE_SIGNING_IDENTITY}" != "-" ]]; then
  bash "${VERIFY_MACOS_SIGNING_SCRIPT}" "${APP_PATH}" "${APPLE_SIGNING_IDENTITY}"
fi

if [[ "${should_package_dmg}" == "1" ]]; then
  bash "${PACKAGE_DMG_SCRIPT}"
fi
