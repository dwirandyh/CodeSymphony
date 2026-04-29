import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

type FileEntry = {
  path: string;
  type: "file" | "directory";
};

type CacheEntry = {
  files: string[];
  directories: string[];
  timestamp: number;
};

const CACHE_TTL_MS = 30_000;

export function createFileService() {
  const cache = new Map<string, CacheEntry>();

  async function listTracked(worktreePath: string): Promise<CacheEntry> {
    const existing = cache.get(worktreePath);
    if (existing && Date.now() - existing.timestamp < CACHE_TTL_MS) {
      return existing;
    }

    const execGit = (args: string[]) =>
      new Promise<string[]>((resolve, reject) => {
        execFile(
          "git",
          args,
          { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 },
          (error, stdout) => {
            if (error) {
              reject(error);
              return;
            }
            const lines = stdout
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0);
            resolve(lines);
          },
        );
      });

    const [allFiles, deletedFiles] = await Promise.all([
      execGit(["ls-files", "--cached", "--others", "--exclude-standard"]),
      execGit(["ls-files", "--deleted"]),
    ]);

    const deletedSet = new Set(deletedFiles);
    const files = allFiles.filter((f) => !deletedSet.has(f));

    const dirSet = new Set<string>();
    for (const filePath of files) {
      let dir = path.dirname(filePath);
      while (dir && dir !== ".") {
        if (dirSet.has(dir)) break;
        dirSet.add(dir);
        dir = path.dirname(dir);
      }
    }

    const directories = Array.from(dirSet).sort();
    const entry: CacheEntry = { files, directories, timestamp: Date.now() };
    cache.set(worktreePath, entry);
    return entry;
  }

  function scoreMatch(entryPath: string, queryLower: string): number {
    const basename = path.basename(entryPath).toLowerCase();
    const fullLower = entryPath.toLowerCase();

    if (basename === queryLower) return 100;
    if (basename.startsWith(queryLower)) return 80;
    if (basename.includes(queryLower)) return 60;

    const segments = fullLower.split("/");
    for (const segment of segments) {
      if (segment.startsWith(queryLower)) return 40;
    }

    if (fullLower.includes(queryLower)) return 20;

    return -1;
  }

  return {
    async listDirectory(
      worktreePath: string,
      relativePath = "",
    ): Promise<FileEntry[]> {
      const targetPath = relativePath
        ? path.resolve(worktreePath, relativePath)
        : path.resolve(worktreePath);

      const dirents = await readdir(targetPath, { withFileTypes: true });
      const entries = await Promise.all(
        dirents.map(async (dirent) => {
          let type: FileEntry["type"] | null = null;

          if (dirent.isDirectory()) {
            type = "directory";
          } else if (dirent.isFile()) {
            type = "file";
          } else if (dirent.isSymbolicLink()) {
            const targetStat = await stat(path.join(targetPath, dirent.name)).catch(() => null);
            if (targetStat?.isDirectory()) {
              type = "directory";
            } else if (targetStat?.isFile()) {
              type = "file";
            }
          }

          if (!type) {
            return null;
          }

          return {
            path: relativePath ? `${relativePath}/${dirent.name}` : dirent.name,
            type,
          } satisfies FileEntry;
        }),
      );

      return entries
        .filter((entry): entry is FileEntry => entry !== null)
        .sort((left, right) => {
          if (left.type !== right.type) {
            return left.type === "directory" ? -1 : 1;
          }

          return left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: "base" });
        });
    },

    async searchFiles(
      worktreePath: string,
      query: string,
      limit = 20,
    ): Promise<FileEntry[]> {
      const { files, directories } = await listTracked(worktreePath);

      if (!query || query.trim().length === 0) {
        const results: FileEntry[] = [
          ...directories.slice(0, 5).map((d) => ({ path: d, type: "directory" as const })),
          ...files.slice(0, limit - Math.min(5, directories.length)).map((f) => ({ path: f, type: "file" as const })),
        ];
        return results.slice(0, limit);
      }

      const queryLower = query.toLowerCase();

      const scored: Array<{ path: string; type: "file" | "directory"; score: number }> = [];

      for (const dirPath of directories) {
        const score = scoreMatch(dirPath, queryLower);
        if (score > 0) {
          scored.push({ path: dirPath, type: "directory", score: score + 1 });
        }
      }

      for (const filePath of files) {
        const score = scoreMatch(filePath, queryLower);
        if (score > 0) {
          scored.push({ path: filePath, type: "file", score });
        }
      }

      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.path.length - b.path.length;
      });

      return scored.slice(0, limit).map((s) => ({ path: s.path, type: s.type }));
    },

    async listFileIndex(
      worktreePath: string,
    ): Promise<FileEntry[]> {
      const { files, directories } = await listTracked(worktreePath);
      return [
        ...directories.map((d) => ({ path: d, type: "directory" as const })),
        ...files.map((f) => ({ path: f, type: "file" as const })),
      ];
    },

    invalidateCache(worktreePath: string): void {
      cache.delete(worktreePath);
    },
  };
}
