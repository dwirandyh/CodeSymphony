#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SCRIPT_DIR}/../src-tauri/binaries"

PACKAGE_MANAGER_VERSION="$(sed -n 's/.*"packageManager":[[:space:]]*"bun@\([^"]*\)".*/\1/p' "${WORKSPACE_ROOT}/package.json" | head -n 1)"
BUN_VERSION="${BUN_VERSION:-${PACKAGE_MANAGER_VERSION:-1.3.14}}"
BASE_URL="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}"

mkdir -p "${BIN_DIR}"

download_bun() {
  local archive_name="$1"
  local triple="$2"
  local target_path="${BIN_DIR}/bun-${triple}"

  if [[ -f "${target_path}" ]]; then
    if [[ -x "${target_path}" ]] && "${target_path}" --version >/dev/null 2>&1; then
      echo "✓ Already exists: bun-${triple}"
      return
    fi

    rm -f "${target_path}"
  fi

  local url="${BASE_URL}/${archive_name}"
  local tmp_dir
  tmp_dir="$(mktemp -d)"

  echo "Downloading Bun ${BUN_VERSION} for ${triple}..."
  curl -fsSL "${url}" -o "${tmp_dir}/${archive_name}"

  echo "Extracting bun binary..."
  unzip -q "${tmp_dir}/${archive_name}" -d "${tmp_dir}"
  mv "${tmp_dir}"/bun-*/bun "${target_path}"
  chmod +x "${target_path}"

  rm -rf "${tmp_dir}"
  echo "✓ Downloaded: bun-${triple}"
}

CURRENT_ARCH="$(uname -m)"

if [[ "${1:-}" == "--all" ]]; then
  download_bun "bun-darwin-aarch64.zip" "aarch64-apple-darwin"
  download_bun "bun-darwin-x64.zip" "x86_64-apple-darwin"
elif [[ "${CURRENT_ARCH}" == "arm64" ]]; then
  download_bun "bun-darwin-aarch64.zip" "aarch64-apple-darwin"
elif [[ "${CURRENT_ARCH}" == "x86_64" ]]; then
  download_bun "bun-darwin-x64.zip" "x86_64-apple-darwin"
else
  echo "Unsupported architecture: ${CURRENT_ARCH}" >&2
  exit 1
fi

echo "Bun binaries ready in ${BIN_DIR}"
