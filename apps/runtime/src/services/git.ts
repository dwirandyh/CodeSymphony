import { promisify } from "node:util";
import { execFile as execFileRaw } from "node:child_process";

const execFile = promisify(execFileRaw);

async function runGit(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFile("git", args, {
      cwd,
      encoding: "utf8",
    });

    return stdout.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : "git command failed";
    throw new Error(`git ${args.join(" ")} failed: ${message}`);
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

  return "main";
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
  await runGit(["-C", args.repositoryPath, "worktree", "remove", "--force", args.worktreePath]);
}
