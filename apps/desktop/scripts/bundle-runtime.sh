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

copy_dependency() {
  local src="$1"
  local target="$2"

  if [[ -L "${target}" && ! -e "${target}" ]]; then
    rm -f "${target}"
  fi

  if [[ -e "${target}" || -L "${target}" ]]; then
    return 0
  fi

  # Follow symlinks when copying so Tauri resources don't end up with broken links.
  cp -RL "${src}" "${target}"
}

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

echo "=== Priming Prisma engines ==="
PRISMA_ENGINE_SUFFIX=""
case "$(uname -m)" in
  arm64)
    PRISMA_ENGINE_SUFFIX="darwin-arm64"
    ;;
  x86_64)
    PRISMA_ENGINE_SUFFIX="darwin"
    ;;
  *)
    echo "Unsupported macOS architecture for Prisma engine bundling: $(uname -m)" >&2
    exit 1
    ;;
esac

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

echo "=== Fixing node-pty permissions ==="
# node-pty v1.x uses prebuilds/<platform>/spawn-helper
# Search the entire bundle to catch all copies (.pnpm, hoisted, scoped)
find "${BUNDLE_DIR}/node_modules" -name "spawn-helper" -exec chmod +x {} \; -exec echo "✓ Fixed permissions: {}" \;

echo "=== Signing bundled macOS native binaries ==="
bash "${SIGN_MACOS_BINARIES_SCRIPT}" "${BUNDLE_DIR}"

echo "=== Runtime bundle ready at ${BUNDLE_DIR} ==="
du -sh "${BUNDLE_DIR}"
