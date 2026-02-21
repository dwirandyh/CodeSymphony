import { readdir } from "node:fs/promises";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { FilesystemEntry } from "@codesymphony/shared-types";

export function createFilesystemService() {
  async function browse(path?: string): Promise<{
    currentPath: string;
    parentPath: string | null;
    entries: FilesystemEntry[];
  }> {
    const targetPath = resolve(path?.trim() || homedir());

    const dirents = await readdir(targetPath, { withFileTypes: true });

    const dirs = dirents.filter((d) => d.isDirectory() || d.isSymbolicLink());

    const gitChecks = await Promise.allSettled(
      dirs.map((d) => access(join(targetPath, d.name, ".git")))
    );

    const entries: FilesystemEntry[] = dirs.map((d, i) => ({
      name: d.name,
      type: d.isSymbolicLink() ? ("symlink" as const) : ("directory" as const),
      isGitRepo: gitChecks[i].status === "fulfilled",
    }));

    entries.sort((a, b) => {
      const aHidden = a.name.startsWith(".");
      const bHidden = b.name.startsWith(".");
      if (aHidden !== bHidden) return aHidden ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

    const parent = dirname(targetPath);
    const parentPath = parent === targetPath ? null : parent;

    return { currentPath: targetPath, parentPath, entries };
  }

  return { browse };
}
