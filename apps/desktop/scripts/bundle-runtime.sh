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

echo "=== Fixing node-pty permissions ==="
# node-pty v1.x uses prebuilds/<platform>/spawn-helper
# Search the entire bundle to catch all copies (.pnpm, hoisted, scoped)
find "${BUNDLE_DIR}/node_modules" -name "spawn-helper" -exec chmod +x {} \; -exec echo "✓ Fixed permissions: {}" \;

echo "=== Runtime bundle ready at ${BUNDLE_DIR} ==="
du -sh "${BUNDLE_DIR}"
