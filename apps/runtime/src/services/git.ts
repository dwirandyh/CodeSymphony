import { promisify } from "node:util";
import { execFile as execFileRaw } from "node:child_process";
import type { ReviewProvider, ReviewState } from "@codesymphony/shared-types";

const execFile = promisify(execFileRaw);
const DEFAULT_GIT_TIMEOUT_MS = 15_000;
const STATUS_GIT_TIMEOUT_MS = 4_000;
const REVIEW_CLI_TIMEOUT_MS = 60_000;

type RunCommandOptions = {
  cwd?: string;
  timeoutMs?: number;
  allowedExitCodes?: number[];
  env?: NodeJS.ProcessEnv;
};

type RunGitOptions = {
  timeoutMs?: number;
  allowedExitCodes?: number[];
};

export type ReviewRemote = {
  remote: string | null;
  remoteUrl: string | null;
  provider: ReviewProvider;
};

export type RemoteReviewRef = {
  number: number;
  url: string;
  headBranch: string;
  baseBranch: string;
  state: ReviewState;
  updatedAt: string | null;
};

async function runCommand(command: string, args: string[], options?: RunCommandOptions): Promise<string> {
  try {
    const { stdout } = await execFile(command, args, {
      cwd: options?.cwd,
      encoding: "utf8",
      timeout: options?.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      env: options?.env,
    });

    return stdout.trimEnd();
  } catch (error) {
    const exitCode = typeof (error as { code?: unknown }).code === "number"
      ? (error as { code: number }).code
      : null;
    const stdout = typeof (error as { stdout?: unknown }).stdout === "string"
      ? (error as { stdout: string }).stdout
      : "";
    const stderr = typeof (error as { stderr?: unknown }).stderr === "string"
      ? (error as { stderr: string }).stderr
      : "";

    if (exitCode !== null && options?.allowedExitCodes?.includes(exitCode)) {
      return stdout.trimEnd();
    }

    if (typeof (error as { code?: unknown }).code === "string" && (error as { code: string }).code === "ENOENT") {
      throw new Error(`${command} is not installed or not available in PATH`);
    }

    const message = stderr.trim() || stdout.trim() || (error instanceof Error ? error.message : `${command} command failed`);
    throw new Error(`${command} ${args.join(" ")} failed: ${message}`);
  }
}

async function runGit(args: string[], cwd?: string, options?: RunGitOptions): Promise<string> {
  return runCommand("git", args, {
    cwd,
    timeoutMs: options?.timeoutMs,
    allowedExitCodes: options?.allowedExitCodes,
  });
}

function parseJsonOutput<T>(output: string, label: string): T {
  try {
    return JSON.parse(output) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`Failed to parse ${label} output: ${message}`);
  }
}

export async function ensureGitRepository(rootPath: string): Promise<void> {
  const output = await runGit(["-C", rootPath, "rev-parse", "--is-inside-work-tree"]);

  if (output !== "true") {
    throw new Error("Path is not a git repository");
  }
}

export async function detectDefaultBranch(rootPath: string): Promise<string> {
  try {
    const ref = await runGit(["-C", rootPath, "symbolic-ref", "refs/remotes/origin/HEAD"]);
    const branch = ref.split("/").at(-1);
    if (branch && branch.length > 0) {
      return branch;
    }
  } catch {
    // fallback
  }

  const localBranch = await runGit(["-C", rootPath, "branch", "--show-current"]);
  if (localBranch.length > 0) {
    return localBranch;
  }

  return "master";
}

export async function listBranches(rootPath: string): Promise<string[]> {
  const output = await runGit([
    "-C", rootPath, "branch", "--all", "--format=%(refname:short)",
  ]);

  if (!output) return [];

  const branches = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((branch) => branch.replace(/^origin\//, ""))
    .filter((branch) => !branch.includes("HEAD"));

  return [...new Set(branches)].sort();
}

export async function getCurrentBranch(cwd: string): Promise<string | null> {
  try {
    const branch = await runGit(["branch", "--show-current"], cwd);
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

export async function createGitWorktree(args: {
  repositoryPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
}): Promise<void> {
  await runGit([
    "-C",
    args.repositoryPath,
    "worktree",
    "add",
    "-b",
    args.branch,
    args.worktreePath,
    args.baseBranch,
  ]);
}

export async function removeGitWorktree(args: { repositoryPath: string; worktreePath: string }): Promise<void> {
  try {
    await runGit(["-C", args.repositoryPath, "worktree", "remove", "--force", args.worktreePath]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("is not a working tree")) {
      await runGit(["-C", args.repositoryPath, "worktree", "prune"]);
      return;
    }
    throw error;
  }
}

export async function renameBranch(args: { cwd: string; oldBranch: string; newBranch: string }): Promise<void> {
  await runGit(["branch", "-m", args.oldBranch, args.newBranch], args.cwd);
}

export async function getUpstreamRemote(cwd: string): Promise<string | null> {
  const upstreamRef = await runGit([
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ], cwd, { allowedExitCodes: [128] }).catch(() => "");

  if (!upstreamRef) {
    return null;
  }

  const [remote] = upstreamRef.split("/");
  return remote?.trim() || null;
}

export async function hasUpstreamBranch(cwd: string): Promise<boolean> {
  return (await getUpstreamRemote(cwd)) !== null;
}

export async function getRemoteUrl(cwd: string, remote: string): Promise<string | null> {
  const output = await runGit(["remote", "get-url", remote], cwd, { allowedExitCodes: [2] }).catch(() => "");
  const trimmed = output.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function detectReviewProvider(remoteUrl: string | null): ReviewProvider {
  if (!remoteUrl) {
    return "unknown";
  }

  const normalized = remoteUrl.toLowerCase();
  if (normalized.includes("github")) {
    return "github";
  }
  if (normalized.includes("gitlab")) {
    return "gitlab";
  }
  return "unknown";
}

export async function resolveReviewRemote(cwd: string): Promise<ReviewRemote> {
  const upstreamRemote = await getUpstreamRemote(cwd);
  const candidates = Array.from(new Set([
    upstreamRemote,
    "origin",
  ].filter((remote): remote is string => Boolean(remote && remote.trim()))));

  let fallbackRemote: string | null = null;
  let fallbackRemoteUrl: string | null = null;

  for (const remote of candidates) {
    const remoteUrl = await getRemoteUrl(cwd, remote);
    if (!remoteUrl) {
      continue;
    }

    const provider = detectReviewProvider(remoteUrl);
    if (provider !== "unknown") {
      return { remote, remoteUrl, provider };
    }

    if (!fallbackRemote) {
      fallbackRemote = remote;
      fallbackRemoteUrl = remoteUrl;
    }
  }

  return {
    remote: fallbackRemote,
    remoteUrl: fallbackRemoteUrl,
    provider: "unknown",
  };
}

export async function ensureCliAvailable(command: "gh" | "glab"): Promise<void> {
  await runCommand(command, ["--version"], { timeoutMs: 5_000 });
}

export async function pushCurrentBranch(cwd: string, remote: string): Promise<void> {
  await runGit(["push", "-u", remote, "HEAD"], cwd, { timeoutMs: REVIEW_CLI_TIMEOUT_MS });
}

export async function listGithubPullRequests(cwd: string, baseBranch: string): Promise<RemoteReviewRef[]> {
  const output = await runCommand("gh", [
    "pr",
    "list",
    "--state",
    "all",
    "--base",
    baseBranch,
    "--json",
    "number,url,headRefName,baseRefName,state,updatedAt",
  ], { cwd, timeoutMs: REVIEW_CLI_TIMEOUT_MS });

  const items = parseJsonOutput<Array<{
    number: number;
    url: string;
    headRefName: string;
    baseRefName: string;
    state: "OPEN" | "MERGED" | "CLOSED";
    updatedAt?: string | null;
  }>>(output || "[]", "gh pr list");

  return items
    .filter((item) => item.headRefName)
    .map((item) => ({
      number: item.number,
      url: item.url,
      headBranch: item.headRefName,
      baseBranch: item.baseRefName,
      state: item.state === "OPEN" ? "open" : item.state === "MERGED" ? "merged" : "closed",
      updatedAt: item.updatedAt ?? null,
    }));
}

export async function createGithubPullRequest(cwd: string, baseBranch: string, headBranch: string): Promise<void> {
  await runCommand("gh", [
    "pr",
    "create",
    "--base",
    baseBranch,
    "--head",
    headBranch,
    "--fill",
  ], { cwd, timeoutMs: REVIEW_CLI_TIMEOUT_MS });
}

export async function listGitlabMergeRequests(cwd: string, baseBranch: string): Promise<RemoteReviewRef[]> {
  const output = await runCommand("glab", [
    "mr",
    "list",
    "--state",
    "all",
    "--target-branch",
    baseBranch,
    "--output",
    "json",
  ], { cwd, timeoutMs: REVIEW_CLI_TIMEOUT_MS });

  const items = parseJsonOutput<Array<{
    iid: number;
    web_url: string;
    source_branch: string;
    target_branch: string;
    state: "opened" | "merged" | "closed";
    updated_at?: string | null;
  }>>(output || "[]", "glab mr list");

  return items
    .filter((item) => item.source_branch)
    .map((item) => ({
      number: item.iid,
      url: item.web_url,
      headBranch: item.source_branch,
      baseBranch: item.target_branch,
      state: item.state === "opened" ? "open" : item.state,
      updatedAt: item.updated_at ?? null,
    }));
}

export async function createGitlabMergeRequest(cwd: string, baseBranch: string, headBranch: string): Promise<void> {
  await runCommand("glab", [
    "mr",
    "create",
    "--source-branch",
    headBranch,
    "--target-branch",
    baseBranch,
    "--fill",
    "--yes",
  ], { cwd, timeoutMs: REVIEW_CLI_TIMEOUT_MS });
}

export async function getGitStatus(cwd: string): Promise<{ branch: string; entries: Array<{ path: string; status: string; insertions: number; deletions: number }> }> {
  const branch = await runGit(["branch", "--show-current"], cwd, { timeoutMs: STATUS_GIT_TIMEOUT_MS }).catch(() => "HEAD");
  let porcelain = "";
  try {
    porcelain = await runGit(["status", "--porcelain"], cwd, { timeoutMs: STATUS_GIT_TIMEOUT_MS });
  } catch {
    return { branch, entries: [] };
  }

  const entries: Array<{ path: string; status: string; insertions: number; deletions: number }> = [];

  const [stagedNumstat, unstagedNumstat] = await Promise.all([
    runGit(["diff", "--cached", "--numstat"], cwd, { timeoutMs: STATUS_GIT_TIMEOUT_MS }).catch(() => ""),
    runGit(["diff", "--numstat"], cwd, { timeoutMs: STATUS_GIT_TIMEOUT_MS }).catch(() => ""),
  ]);

  const statsMap = new Map<string, { insertions: number; deletions: number }>();

  const parseNumstat = (output: string) => {
    for (const line of output.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const insertions = parseInt(parts[0], 10) || 0;
      const deletions = parseInt(parts[1], 10) || 0;
      const path = parts[2];
      const existing = statsMap.get(path) || { insertions: 0, deletions: 0 };
      statsMap.set(path, {
        insertions: existing.insertions + insertions,
        deletions: existing.deletions + deletions,
      });
    }
  };

  parseNumstat(stagedNumstat);
  parseNumstat(unstagedNumstat);

  for (const line of porcelain.split("\n")) {
    if (line.length < 3) continue;
    const x = line[0];
    const y = line[1];
    let filePath = line.substring(3);

    const arrowIdx = filePath.indexOf(" -> ");
    if (arrowIdx >= 0) {
      filePath = filePath.substring(arrowIdx + 4);
    }

    let status: string;
    if (x === "?" && y === "?") status = "untracked";
    else if (x === "D" || y === "D") status = "deleted";
    else if (x === "A") status = "added";
    else if (x === "R" || y === "R") status = "renamed";
    else status = "modified";

    const stats = statsMap.get(filePath) || { insertions: 0, deletions: 0 };
    entries.push({ path: filePath, status, ...stats });
  }

  return { branch, entries };
}

export async function discardGitChange(cwd: string, filePath: string): Promise<void> {
  const status = await runGit(["status", "--porcelain", filePath], cwd);
  if (status.startsWith("??")) {
    await runGit(["clean", "-f", filePath], cwd);
  } else {
    await runGit(["restore", "--source=HEAD", "--staged", "--worktree", filePath], cwd);
  }
}

async function getTrackedGitDiff(cwd: string, filePath?: string): Promise<string> {
  const pathArgs = filePath ? ["--", filePath] : [];

  try {
    return await runGit(["diff", "HEAD", ...pathArgs], cwd);
  } catch {
    try {
      return await runGit(["diff", "--cached", ...pathArgs], cwd);
    } catch {
      return "";
    }
  }
}

async function getUntrackedFilePaths(cwd: string, filePath?: string): Promise<string[]> {
  const pathArgs = filePath ? ["--", filePath] : [];

  try {
    const status = await runGit(["status", "--porcelain", ...pathArgs], cwd, {
      timeoutMs: STATUS_GIT_TIMEOUT_MS,
    });
    return status
      .split("\n")
      .filter((line) => line.startsWith("?? "))
      .map((line) => line.slice(3));
  } catch {
    return [];
  }
}

async function getUntrackedGitDiff(cwd: string, filePaths: string[]): Promise<string> {
  const diffs = await Promise.all(
    filePaths.map((relativePath) => runGit([
      "diff",
      "--no-index",
      "--",
      "/dev/null",
      relativePath,
    ], cwd, { allowedExitCodes: [1] }).catch(() => ""))
  );

  return diffs.filter((diff) => diff.length > 0).join("\n");
}

export async function getGitDiff(cwd: string, filePath?: string): Promise<string> {
  const trackedDiff = await getTrackedGitDiff(cwd, filePath);
  const untrackedFilePaths = await getUntrackedFilePaths(cwd, filePath);

  if (filePath) {
    if (trackedDiff) {
      return trackedDiff;
    }
    if (untrackedFilePaths.length === 0) {
      return "";
    }
    return getUntrackedGitDiff(cwd, untrackedFilePaths);
  }

  const untrackedDiff = await getUntrackedGitDiff(cwd, untrackedFilePaths);
  return [trackedDiff, untrackedDiff].filter((diff) => diff.length > 0).join("\n");
}

export async function getFileAtHead(cwd: string, filePath: string): Promise<string | null> {
  try {
    return await runGit(["show", `HEAD:${filePath}`], cwd);
  } catch {
    return null;
  }
}

export async function gitCommitAll(cwd: string, message: string): Promise<string> {
  await runGit(["add", "-A"], cwd);
  return await runGit(["commit", "-m", message], cwd);
}
