#!/usr/bin/env bash
set -euo pipefail

# Bundle the runtime for Tauri packaging.
# Produces a self-contained runtime-bundle/ directory with:
#   - dist/          (compiled JS)
#   - prisma/        (schema + migrations)
#   - node_modules/  (production dependencies only, installed by Bun)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="${SCRIPT_DIR}/.."
WORKSPACE_ROOT="${DESKTOP_DIR}/../.."
BUNDLE_DIR="$(cd "${DESKTOP_DIR}/src-tauri" && pwd)/runtime-bundle"
SIGN_MACOS_BINARIES_SCRIPT="${SCRIPT_DIR}/sign-macos-binaries.sh"
WRITE_RUNTIME_BUNDLE_MANIFEST_SCRIPT="${SCRIPT_DIR}/write-runtime-bundle-manifest.mjs"
CURRENT_ARCH="$(uname -m)"

case "${CURRENT_ARCH}" in
  arm64)
    PRISMA_ENGINE_SUFFIX="darwin-arm64"
    ;;
  x86_64)
    PRISMA_ENGINE_SUFFIX="darwin"
    ;;
  *)
    echo "Unsupported macOS architecture for Prisma engine bundling: ${CURRENT_ARCH}" >&2
    exit 1
    ;;
esac

assert_no_symlinks_under() {
  local root_dir="$1"
  local first_link=""

  first_link="$(find "${root_dir}" -type l -print -quit)"
  if [[ -n "${first_link}" ]]; then
    echo "Unexpected symlink left in bundled runtime: ${first_link}" >&2
    find "${root_dir}" -type l -print >&2
    exit 1
  fi
}

copy_workspace_package() {
  local package_name="$1"
  local package_dir="$2"
  local target_dir="${BUNDLE_DIR}/node_modules/${package_name}"

  mkdir -p "$(dirname "${target_dir}")"
  rm -rf "${target_dir}"
  mkdir -p "${target_dir}"

  cp "${package_dir}/package.json" "${target_dir}/package.json"
  cp -R "${package_dir}/dist" "${target_dir}/dist"
}

prune_bundle_root() {
  local entry=""
  local name=""

  shopt -s dotglob nullglob
  for entry in "${BUNDLE_DIR}"/* "${BUNDLE_DIR}"/.*; do
    [[ -e "${entry}" || -L "${entry}" ]] || continue
    name="$(basename "${entry}")"

    case "${name}" in
      .|..|android-helpers|android-ws-scrcpy|dist|node_modules|package.json|prisma|simulator-bridge|terminal-zsh|web-dist)
        continue
        ;;
    esac

    rm -rf "${entry}"
  done
  shopt -u dotglob nullglob
}

install_runtime_bundle_dependencies() {
  rm -rf "${BUNDLE_DIR}"
  mkdir -p "${BUNDLE_DIR}"

  bun "${WRITE_RUNTIME_BUNDLE_MANIFEST_SCRIPT}" "${WORKSPACE_ROOT}" "${BUNDLE_DIR}"
  (
    cd "${BUNDLE_DIR}"
    bun install --production --linker=hoisted --no-progress
  )
}

prune_node_pty_prebuilds() {
  local prebuilds_dir="${BUNDLE_DIR}/node_modules/node-pty/prebuilds"
  local keep_dir=""
  local entry=""

  if [[ ! -d "${prebuilds_dir}" ]]; then
    return 0
  fi

  case "${CURRENT_ARCH}" in
    arm64)
      keep_dir="darwin-arm64"
      ;;
    x86_64)
      keep_dir="darwin-x64"
      ;;
  esac

  shopt -s nullglob
  for entry in "${prebuilds_dir}"/*; do
    [[ "$(basename "${entry}")" == "${keep_dir}" ]] && continue
    rm -rf "${entry}"
  done
  shopt -u nullglob
}

prune_claude_sdk_vendor_binaries() {
  local ripgrep_dir="${BUNDLE_DIR}/node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep"
  local keep_dir=""
  local entry=""

  if [[ ! -d "${ripgrep_dir}" ]]; then
    return 0
  fi

  case "${CURRENT_ARCH}" in
    arm64)
      keep_dir="arm64-darwin"
      ;;
    x86_64)
      keep_dir="x64-darwin"
      ;;
  esac

  shopt -s nullglob
  for entry in "${ripgrep_dir}"/*; do
    [[ "$(basename "${entry}")" == "${keep_dir}" ]] && continue
    rm -rf "${entry}"
  done
  shopt -u nullglob
}

prune_prisma_runtime_artifacts() {
  local query_engine_filename="libquery_engine-${PRISMA_ENGINE_SUFFIX}.dylib.node"
  local generated_client_dir="${BUNDLE_DIR}/node_modules/.prisma/client"
  local engine_path=""
  local engine_name=""

  if [[ -d "${generated_client_dir}" ]]; then
    shopt -s nullglob
    for engine_path in "${generated_client_dir}"/libquery_engine-*.dylib.node; do
      [[ -f "${engine_path}" ]] || continue
      engine_name="$(basename "${engine_path}")"
      if [[ "${engine_name}" != "${query_engine_filename}" ]]; then
        rm -f "${engine_path}"
      fi
    done
    shopt -u nullglob
  fi

  rm -rf "${BUNDLE_DIR}/node_modules/@prisma/engines" "${BUNDLE_DIR}/node_modules/prisma"
}

remove_bundle_source_maps() {
  local directory=""

  for directory in \
    "${BUNDLE_DIR}/dist" \
    "${BUNDLE_DIR}/node_modules" \
    "${BUNDLE_DIR}/web-dist" \
    "${BUNDLE_DIR}/android-ws-scrcpy"
  do
    [[ -d "${directory}" ]] || continue
    find "${directory}" -name "*.map" -type f -delete
  done
}

assert_no_prohibited_files() {
  local first_match=""

  first_match="$(find "${BUNDLE_DIR}" \( -name ".env" -o -name "debug.log" -o -name "dev.db" -o -name "test.db" \) -print -quit)"
  if [[ -n "${first_match}" ]]; then
    echo "Found prohibited development artifact in runtime bundle: ${first_match}" >&2
    find "${BUNDLE_DIR}" \( -name ".env" -o -name "debug.log" -o -name "dev.db" -o -name "test.db" \) -print >&2
    exit 1
  fi
}

resolve_terminal_zshrc_source() {
  local candidate=""

  for candidate in \
    "${WORKSPACE_ROOT}/apps/runtime/terminal-zsh/.zshrc" \
    "${WORKSPACE_ROOT}/apps/runtime/assets/terminal-zsh/.zshrc"
  do
    if [[ -f "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  echo "Unable to find terminal zsh bootstrap (.zshrc) for desktop runtime bundle" >&2
  return 1
}

echo "=== Building shared-types ==="
bun run --filter @codesymphony/shared-types build

echo "=== Building chat timeline core ==="
bun run --filter @codesymphony/chat-timeline-core build

echo "=== Building runtime ==="
bun run --filter @codesymphony/runtime build

echo "=== Installing runtime production dependencies ==="
install_runtime_bundle_dependencies

echo "=== Copying compiled JS ==="
rm -rf "${BUNDLE_DIR}/dist"
cp -r "${WORKSPACE_ROOT}/apps/runtime/dist" "${BUNDLE_DIR}/dist"

echo "=== Copying terminal zsh bootstrap ==="
rm -rf "${BUNDLE_DIR}/terminal-zsh"
mkdir -p "${BUNDLE_DIR}/terminal-zsh"
cp "$(resolve_terminal_zshrc_source)" "${BUNDLE_DIR}/terminal-zsh/.zshrc"

echo "=== Copying workspace runtime dependencies ==="
copy_workspace_package "@codesymphony/shared-types" "${WORKSPACE_ROOT}/packages/shared-types"
copy_workspace_package "@codesymphony/chat-timeline-core" "${WORKSPACE_ROOT}/packages/chat-timeline-core"

echo "=== Copying Prisma schema and migrations ==="
rm -rf "${BUNDLE_DIR}/prisma"
mkdir -p "${BUNDLE_DIR}/prisma"
cp "${WORKSPACE_ROOT}/apps/runtime/prisma/schema.prisma" "${BUNDLE_DIR}/prisma/"
if [[ -d "${WORKSPACE_ROOT}/apps/runtime/prisma/migrations" ]]; then
  cp -r "${WORKSPACE_ROOT}/apps/runtime/prisma/migrations" "${BUNDLE_DIR}/prisma/migrations"
fi

echo "=== Copying Android helpers ==="
rm -rf "${BUNDLE_DIR}/android-helpers"
cp -r "${WORKSPACE_ROOT}/apps/runtime/android-helpers" "${BUNDLE_DIR}/android-helpers"

echo "=== Generating Prisma client inside bundle ==="
cd "${BUNDLE_DIR}"
bun x prisma generate --schema=prisma/schema.prisma
cd "${SCRIPT_DIR}"

echo "=== Creating bundled template database ==="
rm -f "${BUNDLE_DIR}/prisma/template.db"
(
  cd "${BUNDLE_DIR}"
  DATABASE_URL="file:${BUNDLE_DIR}/prisma/template.db" \
    bun x prisma migrate deploy --schema=prisma/schema.prisma
)

echo "=== Building web frontend ==="
bun run --filter @codesymphony/web build

echo "=== Copying web dist ==="
rm -rf "${BUNDLE_DIR}/web-dist"
cp -r "${WORKSPACE_ROOT}/apps/web/dist" "${BUNDLE_DIR}/web-dist"

echo "=== Bundling Android ws-scrcpy sidecar ==="
bash "${SCRIPT_DIR}/bundle-android-sidecar.sh" "${BUNDLE_DIR}/android-ws-scrcpy"

echo "=== Bundling iOS SimulatorBridge ==="
SIMULATOR_BRIDGE_DIR="${WORKSPACE_ROOT}/apps/simulator-bridge"
swift build --package-path "${SIMULATOR_BRIDGE_DIR}" -c debug

SIMULATOR_BRIDGE_ARM64_BINARY="${SIMULATOR_BRIDGE_DIR}/.build/arm64-apple-macosx/debug/SimulatorBridge"
SIMULATOR_BRIDGE_DEBUG_BINARY="${SIMULATOR_BRIDGE_DIR}/.build/debug/SimulatorBridge"

if [[ -f "${SIMULATOR_BRIDGE_ARM64_BINARY}" ]]; then
  mkdir -p "${BUNDLE_DIR}/simulator-bridge/.build/arm64-apple-macosx/debug"
  cp "${SIMULATOR_BRIDGE_ARM64_BINARY}" "${BUNDLE_DIR}/simulator-bridge/.build/arm64-apple-macosx/debug/SimulatorBridge"
  chmod +x "${BUNDLE_DIR}/simulator-bridge/.build/arm64-apple-macosx/debug/SimulatorBridge"
elif [[ -f "${SIMULATOR_BRIDGE_DEBUG_BINARY}" ]]; then
  mkdir -p "${BUNDLE_DIR}/simulator-bridge/.build/debug"
  cp "${SIMULATOR_BRIDGE_DEBUG_BINARY}" "${BUNDLE_DIR}/simulator-bridge/.build/debug/SimulatorBridge"
  chmod +x "${BUNDLE_DIR}/simulator-bridge/.build/debug/SimulatorBridge"
else
  echo "SimulatorBridge binary not found after swift build" >&2
  exit 1
fi

NODE_MODULES_DIR="${BUNDLE_DIR}/node_modules"

echo "=== Priming Prisma engines ==="

find_engine_file() {
  local filename="$1"
  local -a candidates=()
  local candidate

  shopt -s nullglob
  candidates=(
    "${WORKSPACE_ROOT}"/apps/runtime/node_modules/@prisma/engines/"${filename}"
    "${WORKSPACE_ROOT}"/apps/runtime/node_modules/prisma/"${filename}"
    "${WORKSPACE_ROOT}"/apps/runtime/node_modules/.prisma/client/"${filename}"
    "${BUNDLE_DIR}"/node_modules/@prisma/engines/"${filename}"
    "${BUNDLE_DIR}"/node_modules/prisma/"${filename}"
    "${BUNDLE_DIR}"/node_modules/.prisma/client/"${filename}"
  )
  shopt -u nullglob

  for candidate in "${candidates[@]}"; do
    if [[ -f "${candidate}" ]]; then
      echo "${candidate}"
      return 0
    fi
  done

  return 1
}

QUERY_ENGINE_FILENAME="libquery_engine-${PRISMA_ENGINE_SUFFIX}.dylib.node"
SCHEMA_ENGINE_FILENAME="schema-engine-${PRISMA_ENGINE_SUFFIX}"
PRISMA_ENGINES_DIR="${NODE_MODULES_DIR}/@prisma/engines"

mkdir -p "${PRISMA_ENGINES_DIR}"

QUERY_ENGINE_SOURCE="$(find_engine_file "${QUERY_ENGINE_FILENAME}")"
SCHEMA_ENGINE_SOURCE="$(find_engine_file "${SCHEMA_ENGINE_FILENAME}")"

if [[ -z "${QUERY_ENGINE_SOURCE}" || -z "${SCHEMA_ENGINE_SOURCE}" ]]; then
  echo "Failed to locate Prisma macOS engines for ${PRISMA_ENGINE_SUFFIX}" >&2
  exit 1
fi

if ! [[ "${QUERY_ENGINE_SOURCE}" -ef "${PRISMA_ENGINES_DIR}/${QUERY_ENGINE_FILENAME}" ]]; then
  cp -f "${QUERY_ENGINE_SOURCE}" "${PRISMA_ENGINES_DIR}/${QUERY_ENGINE_FILENAME}"
fi
if ! [[ "${SCHEMA_ENGINE_SOURCE}" -ef "${PRISMA_ENGINES_DIR}/${SCHEMA_ENGINE_FILENAME}" ]]; then
  cp -f "${SCHEMA_ENGINE_SOURCE}" "${PRISMA_ENGINES_DIR}/${SCHEMA_ENGINE_FILENAME}"
fi
chmod +x "${PRISMA_ENGINES_DIR}/${QUERY_ENGINE_FILENAME}" "${PRISMA_ENGINES_DIR}/${SCHEMA_ENGINE_FILENAME}"

echo "=== Pruning bundled artifacts for production ==="
prune_bundle_root
rm -rf "${BUNDLE_DIR}/android-ws-scrcpy/dist/node_modules/.bin" "${NODE_MODULES_DIR}/.bin"
remove_bundle_source_maps
prune_node_pty_prebuilds
prune_claude_sdk_vendor_binaries
prune_prisma_runtime_artifacts
assert_no_prohibited_files
assert_no_symlinks_under "${BUNDLE_DIR}"

echo "=== Fixing node-pty permissions ==="
# node-pty v1.x uses prebuilds/<platform>/spawn-helper
# Search the entire bundle to catch all copies regardless of Bun's hoisting.
find "${BUNDLE_DIR}/node_modules" -name "spawn-helper" -exec chmod +x {} \; -exec echo "✓ Fixed permissions: {}" \;

echo "=== Signing bundled macOS native binaries ==="
bash "${SIGN_MACOS_BINARIES_SCRIPT}" "${BUNDLE_DIR}"

echo "=== Runtime bundle ready at ${BUNDLE_DIR} ==="
du -sh "${BUNDLE_DIR}"
