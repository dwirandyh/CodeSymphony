import { dirname } from "node:path";
import { getResolvedAgentConfigCached } from "../services/agentConfigService.js";

export function resolveOpencodeBinaryPath(): string {
  const configuredPath = getResolvedAgentConfigCached().opencodePath?.trim();
  if (configuredPath && configuredPath.length > 0) {
    return configuredPath;
  }

  const envBinaryPath = process.env.OPENCODE_BINARY_PATH?.trim();
  return envBinaryPath && envBinaryPath.length > 0
    ? envBinaryPath
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
