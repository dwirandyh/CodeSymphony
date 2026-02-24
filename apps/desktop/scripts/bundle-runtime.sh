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
BUNDLE_DIR="${DESKTOP_DIR}/src-tauri/runtime-bundle"

echo "=== Building shared-types ==="
pnpm --filter @codesymphony/shared-types build

echo "=== Building runtime ==="
pnpm --filter @codesymphony/runtime build

echo "=== Deploying runtime (production deps only) ==="
rm -rf "${BUNDLE_DIR}"
pnpm --filter @codesymphony/runtime deploy --legacy --prod "${BUNDLE_DIR}"

echo "=== Copying compiled JS ==="
cp -r "${WORKSPACE_ROOT}/apps/runtime/dist" "${BUNDLE_DIR}/dist"

echo "=== Copying Prisma schema and migrations ==="
mkdir -p "${BUNDLE_DIR}/prisma"
cp "${WORKSPACE_ROOT}/apps/runtime/prisma/schema.prisma" "${BUNDLE_DIR}/prisma/"
if [[ -d "${WORKSPACE_ROOT}/apps/runtime/prisma/migrations" ]]; then
  cp -r "${WORKSPACE_ROOT}/apps/runtime/prisma/migrations" "${BUNDLE_DIR}/prisma/migrations"
fi

echo "=== Generating Prisma client inside bundle ==="
cd "${BUNDLE_DIR}"
"${WORKSPACE_ROOT}/apps/runtime/node_modules/.bin/prisma" generate --schema=prisma/schema.prisma
cd "${SCRIPT_DIR}"

echo "=== Fixing node-pty permissions ==="
SPAWN_HELPER="${BUNDLE_DIR}/node_modules/node-pty/build/Release/spawn-helper"
if [[ -f "${SPAWN_HELPER}" ]]; then
  chmod +x "${SPAWN_HELPER}"
  echo "✓ Fixed spawn-helper permissions"
fi

echo "=== Runtime bundle ready at ${BUNDLE_DIR} ==="
du -sh "${BUNDLE_DIR}"
