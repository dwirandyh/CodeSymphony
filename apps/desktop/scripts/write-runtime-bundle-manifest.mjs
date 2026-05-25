import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const [workspaceRoot, bundleDir] = process.argv.slice(2);

if (!workspaceRoot || !bundleDir) {
  throw new Error("Usage: bun write-runtime-bundle-manifest.mjs <workspaceRoot> <bundleDir>");
}

const runtimePackagePath = join(workspaceRoot, "apps/runtime/package.json");
const runtimeNodeModulesPath = join(workspaceRoot, "apps/runtime/node_modules");
const runtimePackage = JSON.parse(await readFile(runtimePackagePath, "utf8"));

async function resolveInstalledVersion(name, fallbackVersion) {
  try {
    const installedPackagePath = await realpath(join(runtimeNodeModulesPath, name, "package.json"));
    const installedPackage = JSON.parse(await readFile(installedPackagePath, "utf8"));

    if (typeof installedPackage.version === "string" && installedPackage.version.length > 0) {
      return installedPackage.version;
    }
  } catch {
    // Fall back to the declared semver range if the package cannot be resolved locally.
  }

  return fallbackVersion;
}

const dependencies = Object.fromEntries(
  await Promise.all(
    Object.entries(runtimePackage.dependencies ?? {})
      .filter(([, version]) => version !== "workspace:*")
      .map(async ([name, version]) => [name, await resolveInstalledVersion(name, version)]),
  ),
);

const bundlePackage = {
  name: runtimePackage.name,
  version: runtimePackage.version,
  private: true,
  type: runtimePackage.type,
  dependencies,
};

await mkdir(dirname(join(bundleDir, "package.json")), { recursive: true });
await writeFile(join(bundleDir, "package.json"), `${JSON.stringify(bundlePackage, null, 2)}\n`);
