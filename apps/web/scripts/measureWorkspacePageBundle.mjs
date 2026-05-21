import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const distAssetsDir = path.resolve(process.cwd(), "dist/assets");

function findWorkspaceEntryAsset() {
  const assetFiles = readdirSync(distAssetsDir).filter((file) => file.endsWith(".js"));
  const namedChunk = assetFiles.find((file) => /^WorkspacePage-.*\.js$/u.test(file));
  if (namedChunk) {
    return namedChunk;
  }

  return assetFiles.find((file) => {
    const source = readFileSync(path.join(distAssetsDir, file), "utf-8");
    return source.includes("Loading workspace shell...");
  }) ?? null;
}

const assetFile = findWorkspaceEntryAsset();

if (!assetFile) {
  console.error(`WorkspacePage chunk not found in ${distAssetsDir}. Run "pnpm --filter @codesymphony/web build" first.`);
  process.exit(1);
}

const assetPath = path.join(distAssetsDir, assetFile);
const source = readFileSync(assetPath);
const gzipBytes = gzipSync(source).byteLength;
const minifiedBytes = source.byteLength;
const gzipKb = Math.round((gzipBytes / 1000) * 10) / 10;
const minifiedKb = Math.round((minifiedBytes / 1000) * 10) / 10;

console.log(JSON.stringify({
  metricId: "bundle.workspace_page_gzip_kb",
  assetFile,
  assetPath,
  minifiedBytes,
  minifiedKb,
  gzipBytes,
  gzipKb,
}, null, 2));
