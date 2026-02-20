import { promisify } from "node:util";
import { execFile as execFileRaw } from "node:child_process";

const execFile = promisify(execFileRaw);

async function runGit(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFile("git", args, {
      cwd,
      encoding: "utf8",
    });

    return stdout.trimEnd();
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

export async function renameBranch(args: { cwd: string; oldBranch: string; newBranch: string }): Promise<void> {
  await runGit(["branch", "-m", args.oldBranch, args.newBranch], args.cwd);
}

export async function getGitStatus(cwd: string): Promise<{ branch: string; entries: Array<{ path: string; status: string }> }> {
  const branch = await runGit(["branch", "--show-current"], cwd).catch(() => "HEAD");
  let porcelain = "";
  try {
    porcelain = await runGit(["status", "--porcelain"], cwd);
  } catch {
    return { branch, entries: [] };
  }

  const entries: Array<{ path: string; status: string }> = [];
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

    entries.push({ path: filePath, status });
  }

  return { branch, entries };
}

export async function getGitDiff(cwd: string, filePath?: string): Promise<string> {
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

export async function gitCommitAll(cwd: string, message: string): Promise<string> {
  await runGit(["add", "-A"], cwd);
  return await runGit(["commit", "-m", message], cwd);
}
