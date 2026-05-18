#!/usr/bin/env bash
set -euo pipefail

# Bundle the runtime for Tauri packaging.
# Produces a self-contained runtime-bundle/ directory with:
#   - dist/          (compiled JS)
#   - prisma/        (schema + migrations)
#   - node_modules/  (production dependencies only)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="${SCRIPT_DIR}/.."
WORKSPACE_ROOT="${DESKTOP_DIR}/../.."
BUNDLE_DIR="$(cd "${DESKTOP_DIR}/src-tauri" && pwd)/runtime-bundle"
SIGN_MACOS_BINARIES_SCRIPT="${SCRIPT_DIR}/sign-macos-binaries.sh"
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

copy_dependency() {
  local src="$1"
  local target="$2"

  if [[ -L "${target}" ]]; then
    rm -rf "${target}"
  fi

  if [[ -e "${target}" ]]; then
    return 0
  fi

  # Follow symlinks when copying so the staged bundle does not depend on pnpm's
  # virtual store layout. Tauri otherwise materializes those links into huge
  # duplicate trees during app packaging.
  cp -RL "${src}" "${target}"
}

assert_no_external_symlinks() {
  local root_dir="$1"

  ROOT_DIR="${root_dir}" node <<'EOF'
const fs = require("fs");
const path = require("path");

const root = path.resolve(process.env.ROOT_DIR);
const invalid = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);

    if (entry.isSymbolicLink()) {
      const resolved = fs.realpathSync(entryPath);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        invalid.push({ entryPath, resolved });
      }
      continue;
    }

    if (entry.isDirectory()) {
      walk(entryPath);
    }
  }
}

walk(root);

if (invalid.length > 0) {
  console.error("Found symlinks escaping the runtime bundle:");
  for (const item of invalid) {
    console.error(`${item.entryPath} -> ${item.resolved}`);
  }
  process.exit(1);
}
EOF
}

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

prune_bundle_root() {
  local entry=""
  local name=""

  shopt -s dotglob nullglob
  for entry in "${BUNDLE_DIR}"/* "${BUNDLE_DIR}"/.*; do
    [[ -e "${entry}" || -L "${entry}" ]] || continue
    name="$(basename "${entry}")"

    case "${name}" in
      .|..|android-helpers|android-ws-scrcpy|dist|node_modules|package.json|prisma|simulator-bridge|web-dist)
        continue
        ;;
    esac

    rm -rf "${entry}"
  done
  shopt -u dotglob nullglob
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

echo "=== Building shared-types ==="
pnpm --filter @codesymphony/shared-types build

echo "=== Building runtime ==="
pnpm --filter @codesymphony/runtime build

echo "=== Deploying runtime (production deps only) ==="
rm -rf "${BUNDLE_DIR}"
pnpm --filter @codesymphony/runtime deploy --legacy --prod "${BUNDLE_DIR}"

echo "=== Copying compiled JS ==="
rm -rf "${BUNDLE_DIR}/dist"
cp -r "${WORKSPACE_ROOT}/apps/runtime/dist" "${BUNDLE_DIR}/dist"

echo "=== Copying Prisma schema and migrations ==="
# Remove existing prisma dir from pnpm deploy to avoid nested migrations/migrations/
rm -rf "${BUNDLE_DIR}/prisma"
mkdir -p "${BUNDLE_DIR}/prisma"
cp "${WORKSPACE_ROOT}/apps/runtime/prisma/schema.prisma" "${BUNDLE_DIR}/prisma/"
if [[ -d "${WORKSPACE_ROOT}/apps/runtime/prisma/migrations" ]]; then
  cp -r "${WORKSPACE_ROOT}/apps/runtime/prisma/migrations" "${BUNDLE_DIR}/prisma/migrations"
fi

echo "=== Generating Prisma client inside bundle ==="
cd "${BUNDLE_DIR}"
"${WORKSPACE_ROOT}/apps/runtime/node_modules/.bin/prisma" generate --schema=prisma/schema.prisma
cd "${SCRIPT_DIR}"

echo "=== Creating bundled template database ==="
rm -f "${BUNDLE_DIR}/prisma/template.db"
(
  cd "${BUNDLE_DIR}"
  DATABASE_URL="file:${BUNDLE_DIR}/prisma/template.db" \
    "${WORKSPACE_ROOT}/apps/runtime/node_modules/.bin/prisma" migrate deploy --schema=prisma/schema.prisma
)

echo "=== Building web frontend ==="
pnpm --filter @codesymphony/web build

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

echo "=== Hoisting transitive dependencies for Tauri bundle ==="
NODE_MODULES_DIR="${BUNDLE_DIR}/node_modules"

(
  shopt -s dotglob nullglob
  for entry in "${NODE_MODULES_DIR}"/.pnpm/*/node_modules/*; do
    [[ -e "${entry}" || -L "${entry}" ]] || continue
    name="$(basename "${entry}")"
    [[ "${name}" == ".bin" ]] && continue

    if [[ "${name}" == @* && -d "${entry}" ]]; then
      mkdir -p "${NODE_MODULES_DIR}/${name}"
      for scoped_pkg in "${entry}"/*; do
        [[ -e "${scoped_pkg}" || -L "${scoped_pkg}" ]] || continue
        target="${NODE_MODULES_DIR}/${name}/$(basename "${scoped_pkg}")"
        copy_dependency "${scoped_pkg}" "${target}"
      done
    else
      target="${NODE_MODULES_DIR}/${name}"
      copy_dependency "${entry}" "${target}"
    fi
  done
)

echo "=== Removing pnpm virtual store from staged bundle ==="
rm -rf "${NODE_MODULES_DIR}/.pnpm" "${NODE_MODULES_DIR}/.bin"
assert_no_external_symlinks "${BUNDLE_DIR}"

echo "=== Priming Prisma engines ==="

find_engine_file() {
  local filename="$1"
  local -a candidates=()
  local candidate

  shopt -s nullglob
  candidates=(
    "${WORKSPACE_ROOT}"/node_modules/.pnpm/@prisma+engines@*/node_modules/@prisma/engines/"${filename}"
    "${WORKSPACE_ROOT}"/node_modules/.pnpm/prisma@*/node_modules/prisma/"${filename}"
    "${WORKSPACE_ROOT}"/node_modules/.pnpm/@prisma+client@*/node_modules/.prisma/client/"${filename}"
    "${BUNDLE_DIR}"/node_modules/.pnpm/@prisma+engines@*/node_modules/@prisma/engines/"${filename}"
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

cp -f "${QUERY_ENGINE_SOURCE}" "${PRISMA_ENGINES_DIR}/${QUERY_ENGINE_FILENAME}"
cp -f "${SCHEMA_ENGINE_SOURCE}" "${PRISMA_ENGINES_DIR}/${SCHEMA_ENGINE_FILENAME}"
chmod +x "${PRISMA_ENGINES_DIR}/${QUERY_ENGINE_FILENAME}" "${PRISMA_ENGINES_DIR}/${SCHEMA_ENGINE_FILENAME}"

echo "=== Pruning bundled artifacts for production ==="
prune_bundle_root
rm -rf "${BUNDLE_DIR}/android-ws-scrcpy/dist/node_modules/.bin"
remove_bundle_source_maps
prune_node_pty_prebuilds
prune_claude_sdk_vendor_binaries
prune_prisma_runtime_artifacts
assert_no_prohibited_files
assert_no_symlinks_under "${BUNDLE_DIR}"

echo "=== Fixing node-pty permissions ==="
# node-pty v1.x uses prebuilds/<platform>/spawn-helper
# Search the entire bundle to catch all copies (.pnpm, hoisted, scoped)
find "${BUNDLE_DIR}/node_modules" -name "spawn-helper" -exec chmod +x {} \; -exec echo "✓ Fixed permissions: {}" \;

echo "=== Signing bundled macOS native binaries ==="
bash "${SIGN_MACOS_BINARIES_SCRIPT}" "${BUNDLE_DIR}"

echo "=== Runtime bundle ready at ${BUNDLE_DIR} ==="
du -sh "${BUNDLE_DIR}"
