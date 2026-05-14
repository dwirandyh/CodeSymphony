import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import type {
  FilesystemEntry,
  FilesystemReadAttachment,
  FilesystemWriteTerminalDropFile,
  FilesystemWriteTerminalDropResult,
} from "@codesymphony/shared-types";

const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;
const TERMINAL_DROP_DIR_PREFIX = "cs-terminal-drop-";
const TERMINAL_DROP_TTL_MS = 6 * 60 * 60 * 1000;

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

function sanitizeTerminalDropFilename(filename: string, index: number): string {
  const trimmed = basename(filename.trim());
  return trimmed.length > 0 ? trimmed : `attachment-${index + 1}`;
}

function sanitizeTerminalDropSessionId(sessionId: string): string {
  const sanitized = sessionId.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "session";
}

export function createFilesystemService() {
  const terminalDropDirsBySessionId = new Map<string, Set<string>>();
  const terminalDropCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  async function cleanupTrackedTerminalDropDir(sessionId: string, dirPath: string): Promise<void> {
    const timeoutId = terminalDropCleanupTimers.get(dirPath);
    if (timeoutId) {
      clearTimeout(timeoutId);
      terminalDropCleanupTimers.delete(dirPath);
    }

    await rm(dirPath, { recursive: true, force: true }).catch(() => {});

    const trackedDirs = terminalDropDirsBySessionId.get(sessionId);
    if (!trackedDirs) {
      return;
    }

    trackedDirs.delete(dirPath);
    if (trackedDirs.size === 0) {
      terminalDropDirsBySessionId.delete(sessionId);
    }
  }

  function trackTerminalDropDir(sessionId: string, dirPath: string): void {
    const trackedDirs = terminalDropDirsBySessionId.get(sessionId) ?? new Set<string>();
    trackedDirs.add(dirPath);
    terminalDropDirsBySessionId.set(sessionId, trackedDirs);

    const existingTimeoutId = terminalDropCleanupTimers.get(dirPath);
    if (existingTimeoutId) {
      clearTimeout(existingTimeoutId);
    }

    const timeoutId = setTimeout(() => {
      terminalDropCleanupTimers.delete(dirPath);
      void cleanupTrackedTerminalDropDir(sessionId, dirPath);
    }, TERMINAL_DROP_TTL_MS);
    terminalDropCleanupTimers.set(dirPath, timeoutId);
  }

  async function cleanupStaleTerminalDropDirs(): Promise<void> {
    const tempRoot = tmpdir();
    const dirEntries = await readdir(tempRoot, { withFileTypes: true }).catch(() => []);
    const cutoff = Date.now() - TERMINAL_DROP_TTL_MS;

    await Promise.all(dirEntries.map(async (entry) => {
      if (!entry.isDirectory() || !entry.name.startsWith(TERMINAL_DROP_DIR_PREFIX)) {
        return;
      }

      const dirPath = join(tempRoot, entry.name);
      const dirStat = await stat(dirPath).catch(() => null);
      if (!dirStat || dirStat.mtimeMs >= cutoff) {
        return;
      }

      await rm(dirPath, { recursive: true, force: true }).catch(() => {});
    }));
  }

  void cleanupStaleTerminalDropDirs();

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

  async function writeTerminalDropFiles(
    sessionId: string,
    files: FilesystemWriteTerminalDropFile[],
  ): Promise<FilesystemWriteTerminalDropResult[]> {
    await cleanupStaleTerminalDropDirs();

    const tempDir = await mkdtemp(join(tmpdir(), `${TERMINAL_DROP_DIR_PREFIX}${sanitizeTerminalDropSessionId(sessionId)}-`));
    trackTerminalDropDir(sessionId, tempDir);
    const writtenFiles: FilesystemWriteTerminalDropResult[] = [];

    for (const [index, file] of files.entries()) {
      const filename = sanitizeTerminalDropFilename(file.filename, index);
      const buffer = Buffer.from(file.contentBase64, "base64");

      if (buffer.byteLength > MAX_ATTACHMENT_SIZE_BYTES) {
        throw new Error(`File "${filename}" exceeds the 10 MB terminal drop limit`);
      }

      const outputPath = join(tempDir, `${String(index + 1).padStart(2, "0")}-${filename}`);
      await writeFile(outputPath, buffer);

      writtenFiles.push({
        path: outputPath,
        filename,
        mimeType: file.mimeType,
        sizeBytes: buffer.byteLength,
      });
    }

    return writtenFiles;
  }

  async function cleanupTerminalDropFiles(sessionId: string): Promise<void> {
    const trackedDirs = Array.from(terminalDropDirsBySessionId.get(sessionId) ?? []);
    await Promise.all(trackedDirs.map((dirPath) => cleanupTrackedTerminalDropDir(sessionId, dirPath)));
  }

  return { browse, readAttachments, writeTerminalDropFiles, cleanupTerminalDropFiles };
}
