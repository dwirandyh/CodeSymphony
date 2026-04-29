#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="${SCRIPT_DIR}/.."
APP_PATH="${1:-${DESKTOP_DIR}/src-tauri/target/release/bundle/macos/CodeSymphony.app}"
DMG_PATH="${2:-}"
VOLUME_NAME="${3:-CodeSymphony}"
SIGNING_IDENTITY="${CODESYMPHONY_MACOS_SIGN_IDENTITY:-${APPLE_SIGNING_IDENTITY:-}}"
SOURCE_DIR="$(cd "${DESKTOP_DIR}/src-tauri/target/release/bundle/macos" && pwd)"
DMG_DIR="${DESKTOP_DIR}/src-tauri/target/release/bundle/dmg"
APP_NAME="$(basename "${APP_PATH}" .app)"
APPLICATIONS_LINK="${SOURCE_DIR}/Applications"

if [[ ! -d "${APP_PATH}" ]]; then
  echo "App bundle not found: ${APP_PATH}" >&2
  exit 1
fi

if [[ -z "${DMG_PATH}" ]]; then
  if [[ -d "${DMG_DIR}" ]]; then
    DMG_PATH="$(find "${DMG_DIR}" -maxdepth 1 -type f -name '*.dmg' | head -n 1)"
  fi
fi

if [[ -z "${DMG_PATH}" ]]; then
  DMG_PATH="${DMG_DIR}/${APP_NAME}.dmg"
fi

mkdir -p "$(dirname "${DMG_PATH}")"

cleanup() {
  rm -f "${APPLICATIONS_LINK}"
}
trap cleanup EXIT

echo "=== Repacking DMG from signed app ==="
codesign --verify --deep --strict --verbose=2 "${APP_PATH}"
find "${SOURCE_DIR}" -maxdepth 1 -type f -name 'rw.*.dmg' -delete
rm -f "${APPLICATIONS_LINK}"
ln -s /Applications "${APPLICATIONS_LINK}"
rm -f "${DMG_PATH}"
hdiutil create \
  -volname "${VOLUME_NAME}" \
  -srcfolder "${SOURCE_DIR}" \
  -ov \
  -format UDZO \
  "${DMG_PATH}"

if [[ -n "${SIGNING_IDENTITY}" && "${SIGNING_IDENTITY}" != "-" ]]; then
  codesign --force --sign "${SIGNING_IDENTITY}" "${DMG_PATH}"
fi

echo "DMG ready at ${DMG_PATH}"
