#!/usr/bin/env bash
set -euo pipefail

APP_PATH="${1:-}"
EXPECTED_IDENTITY="${2:-${CODESYMPHONY_MACOS_SIGN_IDENTITY:-${APPLE_SIGNING_IDENTITY:-}}}"

if [[ -z "${APP_PATH}" ]]; then
  echo "Usage: $0 <app-path> [expected-signing-identity]" >&2
  exit 1
fi

if [[ ! -d "${APP_PATH}" ]]; then
  echo "App bundle not found: ${APP_PATH}" >&2
  exit 1
fi

echo "=== Verifying app bundle signature ==="
codesign --verify --deep --strict --verbose=2 "${APP_PATH}"

inspect_signature() {
  local path="$1"
  local output=""

  if ! file -b "${path}" | grep -q "Mach-O"; then
    return 0
  fi

  output="$(codesign -dv --verbose=4 "${path}" 2>&1)"

  if printf '%s\n' "${output}" | grep -q "Signature=adhoc"; then
    echo "Ad-hoc signature detected: ${path}" >&2
    exit 1
  fi

  if printf '%s\n' "${output}" | grep -q "TeamIdentifier=not set"; then
    echo "Unsigned team identifier detected: ${path}" >&2
    exit 1
  fi

  if ! printf '%s\n' "${output}" | grep -q "^Authority="; then
    echo "No signing authority found for: ${path}" >&2
    exit 1
  fi

  if [[ -n "${EXPECTED_IDENTITY}" ]] && ! printf '%s\n' "${output}" | grep -Fq "Authority=${EXPECTED_IDENTITY}"; then
    echo "Expected signing identity not found for: ${path}" >&2
    echo "Expected: ${EXPECTED_IDENTITY}" >&2
    printf '%s\n' "${output}" | sed -n 's/^Authority=/Actual: /p' >&2
    exit 1
  fi
}

echo "=== Verifying nested macOS binaries are non-adhoc and use the expected identity ==="
while IFS= read -r -d '' path; do
  inspect_signature "${path}"
done < <(
  find "${APP_PATH}/Contents" -type f \
    \( -path "*/MacOS/*" -o -name "*.node" -o -name "*.dylib" -o -name "SimulatorBridge" -o -perm -111 \) \
    -print0
)

echo "Verified signed macOS app bundle: ${APP_PATH}"
if [[ -n "${EXPECTED_IDENTITY}" ]]; then
  echo "Signing identity: ${EXPECTED_IDENTITY}"
fi
