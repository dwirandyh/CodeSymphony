#!/usr/bin/env bash
set -euo pipefail

# Download Node.js v22 LTS binary for Tauri bundling.
# Places binaries with Tauri's target-triple naming convention.

NODE_VERSION="v22.14.0"
BASE_URL="https://nodejs.org/dist/${NODE_VERSION}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="${SCRIPT_DIR}/../src-tauri/binaries"
mkdir -p "${BIN_DIR}"

download_node() {
  local arch="$1"    # e.g. arm64, x64
  local triple="$2"  # e.g. aarch64-apple-darwin, x86_64-apple-darwin

  local target_path="${BIN_DIR}/node-${triple}"

  if [[ -f "${target_path}" ]]; then
    echo "✓ Already exists: node-${triple}"
    return
  fi

  local platform="darwin"
  local archive="node-${NODE_VERSION}-${platform}-${arch}.tar.gz"
  local url="${BASE_URL}/${archive}"
  local tmp_dir
  tmp_dir="$(mktemp -d)"

  echo "Downloading Node.js ${NODE_VERSION} for ${triple}..."
  curl -fsSL "${url}" -o "${tmp_dir}/${archive}"

  echo "Extracting node binary..."
  tar -xzf "${tmp_dir}/${archive}" -C "${tmp_dir}" --strip-components=2 "node-${NODE_VERSION}-${platform}-${arch}/bin/node"

  mv "${tmp_dir}/node" "${target_path}"
  chmod +x "${target_path}"

  rm -rf "${tmp_dir}"
  echo "✓ Downloaded: node-${triple}"
}

# Detect current architecture and only download what's needed,
# but also support cross-compilation by downloading both.
CURRENT_ARCH="$(uname -m)"

if [[ "${1:-}" == "--all" ]]; then
  download_node "arm64" "aarch64-apple-darwin"
  download_node "x64" "x86_64-apple-darwin"
elif [[ "${CURRENT_ARCH}" == "arm64" ]]; then
  download_node "arm64" "aarch64-apple-darwin"
elif [[ "${CURRENT_ARCH}" == "x86_64" ]]; then
  download_node "x64" "x86_64-apple-darwin"
else
  echo "Unsupported architecture: ${CURRENT_ARCH}"
  exit 1
fi

echo "Node.js binaries ready in ${BIN_DIR}"
