#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_APP_PATH="${SCRIPT_DIR}/../src-tauri/target/release/bundle/macos/CodeSymphony.app"
explicit_identity="${CODESYMPHONY_MACOS_SIGN_IDENTITY:-${APPLE_SIGNING_IDENTITY:-}}"

if [[ -n "${explicit_identity}" ]]; then
  printf '%s\n' "${explicit_identity}"
  exit 0
fi

extract_bundle_identity() {
  local app_path="$1"
  local output=""

  if [[ ! -d "${app_path}" ]]; then
    return 0
  fi

  output="$(codesign -dv --verbose=4 "${app_path}" 2>&1 || true)"
  if [[ -z "${output}" ]]; then
    return 0
  fi

  if printf '%s\n' "${output}" | grep -q "Signature=adhoc"; then
    return 0
  fi

  printf '%s\n' "${output}" \
    | sed -n 's/^Authority=\(.*\)$/\1/p' \
    | grep -v '^Apple Worldwide Developer Relations Certification Authority$' \
    | grep -v '^Apple Root CA$' \
    | head -n 1 \
    || true
}

bundle_identity="$(extract_bundle_identity "${DEFAULT_APP_PATH}")"
if [[ -n "${bundle_identity}" ]]; then
  echo "Using the existing workspace app signing identity from ${DEFAULT_APP_PATH}." >&2
  printf '%s\n' "${bundle_identity}"
  exit 0
fi

identities="$(security find-identity -v -p codesigning 2>/dev/null || true)"

collect_identities() {
  local label="$1"

  printf '%s\n' "${identities}" \
    | grep -F "${label}" \
    | grep -v "CSSMERR_" \
    | sed -E 's/^[[:space:]]*[0-9]+\)[[:space:]]+[0-9A-F]+[[:space:]]+"([^"]+)".*$/\1/' \
    | sed '/^$/d' \
    || true
}

resolve_unique_identity() {
  local label="$1"
  local usage_note="$2"
  local candidates=""
  local count=0

  candidates="$(collect_identities "${label}")"
  if [[ -z "${candidates}" ]]; then
    return 0
  fi

  count="$(printf '%s\n' "${candidates}" | wc -l | tr -d ' ')"
  if [[ "${count}" == "1" ]]; then
    if [[ -n "${usage_note}" ]]; then
      echo "${usage_note}" >&2
    fi
    printf '%s\n' "${candidates}"
    exit 0
  fi

  echo "Multiple usable ${label} certificates were found. Set CODESYMPHONY_MACOS_SIGN_IDENTITY explicitly." >&2
  printf '%s\n' "${candidates}" >&2
  exit 1
}

resolve_unique_identity "Developer ID Application:" ""
resolve_unique_identity "Apple Development:" "Using Apple Development certificate for macOS release signing. Set CODESYMPHONY_MACOS_SIGN_IDENTITY to override."
resolve_unique_identity "Apple Distribution:" "Using Apple Distribution certificate for macOS release signing. Set CODESYMPHONY_MACOS_SIGN_IDENTITY to override."

echo "No usable macOS codesigning identity was found." >&2
exit 1
