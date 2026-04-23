import { dirname } from "node:path";

export function resolveOpencodeBinaryPath(): string {
  const configuredBinaryPath = process.env.OPENCODE_BINARY_PATH?.trim();
  return configuredBinaryPath && configuredBinaryPath.length > 0
    ? configuredBinaryPath
    : "opencode";
}

export function ensureConfiguredOpencodeBinaryOnPath(): void {
  const configuredBinaryPath = process.env.OPENCODE_BINARY_PATH?.trim();
  if (!configuredBinaryPath || !/[\\/]/.test(configuredBinaryPath)) {
    return;
  }

  const binaryDir = dirname(configuredBinaryPath);
  if (binaryDir === ".") {
    return;
  }

  const pathSeparator = process.platform === "win32" ? ";" : ":";
  const currentPath = process.env.PATH ?? "";
  const pathEntries = currentPath.split(pathSeparator).filter(Boolean);
  if (pathEntries.includes(binaryDir)) {
    return;
  }

  process.env.PATH = currentPath.length > 0 ? `${binaryDir}${pathSeparator}${currentPath}` : binaryDir;
}
