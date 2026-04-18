import { access, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { FilesystemEntry, FilesystemReadAttachment } from "@codesymphony/shared-types";

const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;

const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  ".c": "text/x-c",
  ".cpp": "text/x-c++src",
  ".css": "text/css",
  ".gif": "image/gif",
  ".go": "text/x-go",
  ".h": "text/x-c",
  ".hpp": "text/x-c++hdr",
  ".htm": "text/html",
  ".html": "text/html",
  ".java": "text/x-java-source",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".jsx": "text/jsx",
  ".md": "text/markdown",
  ".png": "image/png",
  ".py": "text/x-python",
  ".rs": "text/rust",
  ".scss": "text/x-scss",
  ".sh": "text/x-shellscript",
  ".sql": "application/sql",
  ".svg": "image/svg+xml",
  ".toml": "application/toml",
  ".ts": "text/typescript",
  ".tsx": "text/tsx",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

export function detectMimeType(filePath: string): string {
  return MIME_TYPES_BY_EXTENSION[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

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

  async function readAttachments(paths: string[]): Promise<FilesystemReadAttachment[]> {
    const uniquePaths = Array.from(
      new Set(paths.map((entry) => entry.trim()).filter((entry) => entry.length > 0).map((entry) => resolve(entry))),
    );

    const attachments: FilesystemReadAttachment[] = [];

    for (const filePath of uniquePaths) {
      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat?.isFile() || fileStat.size > MAX_ATTACHMENT_SIZE_BYTES) {
        continue;
      }

      const mimeType = detectMimeType(filePath);
      const buffer = await readFile(filePath);

      attachments.push({
        path: filePath,
        filename: basename(filePath),
        mimeType,
        sizeBytes: fileStat.size,
        content: isImageMimeType(mimeType) ? buffer.toString("base64") : buffer.toString("utf8"),
      });
    }

    return attachments;
  }

  return { browse, readAttachments };
}
