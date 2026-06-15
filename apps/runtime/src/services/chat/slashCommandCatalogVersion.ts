import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliAgent } from "@codesymphony/shared-types";
import {
  DEFAULT_CLAUDE_EXECUTABLE,
  buildExecutableCandidates,
} from "../../claude/executableResolver.js";
import { resolveOpencodeBinaryPath } from "../../opencode/binary.js";
import { resolveCodexBinaryPath } from "../../codex/sessionRunner.js";
import { getResolvedAgentConfigCached } from "../agentConfigService.js";
import { resolveCodexSkillCatalogCacheVersion } from "./codexSkills.js";

const AGENT_VERSION_CACHE_TTL_MS = 5 * 60_000;
const COMMAND_FILE_SCAN_MAX_DEPTH = 6;

type CachedAgentVersionEntry = {
  value: string | null;
  resolvedAtMs: number;
};

const cachedAgentVersions = new Map<CliAgent, CachedAgentVersionEntry>();

function normalizeBinaryVersionOutput(stdout: string, stderr: string): string | null {
  const candidate = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return candidate ?? null;
}

function readBinaryVersion(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!result || result.error || result.status !== 0) {
    return null;
  }

  return normalizeBinaryVersionOutput(result.stdout ?? "", result.stderr ?? "");
}

function resolveClaudeBinaryVersion(): string | null {
  const configuredExecutable = getResolvedAgentConfigCached().claudePath?.trim()
    || process.env.CLAUDE_CODE_EXECUTABLE?.trim()
    || DEFAULT_CLAUDE_EXECUTABLE;
  for (const candidate of buildExecutableCandidates(configuredExecutable)) {
    const version = readBinaryVersion(candidate);
    if (version) {
      return version;
    }
  }

  return null;
}

function resolveAgentBinaryVersion(agent: CliAgent): string | null {
  if (agent === "claude") {
    return resolveClaudeBinaryVersion();
  }

  if (agent === "codex") {
    return readBinaryVersion(resolveCodexBinaryPath());
  }

  if (agent === "cursor") {
    return readBinaryVersion(process.env.CURSOR_AGENT_BINARY_PATH?.trim() || "cursor-agent");
  }

  return readBinaryVersion(resolveOpencodeBinaryPath());
}

function getCachedAgentVersion(agent: CliAgent, now = Date.now()): string | null | undefined {
  const cached = cachedAgentVersions.get(agent);
  if (!cached) {
    return undefined;
  }

  if (now - cached.resolvedAtMs >= AGENT_VERSION_CACHE_TTL_MS) {
    cachedAgentVersions.delete(agent);
    return undefined;
  }

  return cached.value;
}

function resolveCurrentAgentVersion(agent: CliAgent): string | null {
  const cached = getCachedAgentVersion(agent);
  if (cached !== undefined) {
    return cached;
  }

  const version = resolveAgentBinaryVersion(agent);
  cachedAgentVersions.set(agent, {
    value: version,
    resolvedAtMs: Date.now(),
  });
  return version;
}

function getClaudeCommandCandidateRoots(worktreePath: string): string[] {
  return [
    join(worktreePath, ".claude", "commands"),
    join(worktreePath, ".claude", "command"),
    join(worktreePath, ".agents", "commands"),
    join(worktreePath, ".agents", "command"),
    join(homedir(), ".claude", "commands"),
    join(homedir(), ".claude", "command"),
    join(homedir(), ".agents", "commands"),
    join(homedir(), ".agents", "command"),
  ];
}

function collectMarkdownCommandFiles(rootPath: string, depth = 0): string[] {
  if (!existsSync(rootPath) || depth > COMMAND_FILE_SCAN_MAX_DEPTH) {
    return [];
  }

  let stats;
  try {
    stats = statSync(rootPath);
  } catch {
    return [];
  }

  if (!stats.isDirectory()) {
    return [];
  }

  let entries: string[] = [];
  try {
    entries = readdirSync(rootPath);
  } catch {
    return [];
  }

  return entries.flatMap((entry) => {
    const nextPath = join(rootPath, entry);
    try {
      const nextStats = statSync(nextPath);
      if (nextStats.isDirectory()) {
        return collectMarkdownCommandFiles(nextPath, depth + 1);
      }
      return entry.endsWith(".md") ? [nextPath] : [];
    } catch {
      return [];
    }
  });
}

function resolveCommandFileSetVersion(commandFilePaths: string[]): string {
  const hash = createHash("sha1");
  if (commandFilePaths.length === 0) {
    hash.update("no-command-files");
    return hash.digest("hex");
  }

  for (const commandFilePath of commandFilePaths) {
    try {
      const stats = statSync(commandFilePath);
      hash.update(commandFilePath);
      hash.update("\0");
      hash.update(String(stats.size));
      hash.update("\0");
      hash.update(String(stats.mtimeMs));
      hash.update("\0");
    } catch {
      hash.update(commandFilePath);
      hash.update("\0missing\0");
    }
  }

  return hash.digest("hex");
}

function resolveLocalSlashCommandSourceVersion(worktreePath: string, agent: CliAgent): string {
  if (agent === "codex" || agent === "cursor" || agent === "opencode") {
    return resolveCodexSkillCatalogCacheVersion(worktreePath);
  }

  if (agent !== "claude") {
    return "no-local-slash-command-sources";
  }

  const commandFiles = getClaudeCommandCandidateRoots(worktreePath)
    .flatMap((rootPath) => collectMarkdownCommandFiles(rootPath))
    .sort((left, right) => left.localeCompare(right));
  return resolveCommandFileSetVersion(commandFiles);
}

export function clearSlashCommandCatalogVersionCache(): void {
  cachedAgentVersions.clear();
}

export function resolveSlashCommandCatalogCacheVersion(worktreePath: string, agent: CliAgent): string {
  const hash = createHash("sha1");
  hash.update(agent);
  hash.update("\0");
  hash.update(resolveCurrentAgentVersion(agent) ?? "unknown-agent-version");
  hash.update("\0");
  hash.update(resolveLocalSlashCommandSourceVersion(worktreePath, agent));
  return hash.digest("hex");
}
