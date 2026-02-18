export interface DiffLine {
  type: "context" | "addition" | "deletion";
  content: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  oldPath: string;
  newPath: string;
  status: "modified" | "added" | "deleted" | "renamed";
  hunks: DiffHunk[];
}

export function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = raw.split("\n");
  let i = 0;

  while (i < lines.length) {
    if (!lines[i].startsWith("diff --git")) {
      i++;
      continue;
    }

    const match = lines[i].match(/^diff --git a\/(.+) b\/(.+)$/);
    if (!match) {
      i++;
      continue;
    }

    const oldPath = match[1];
    const newPath = match[2];
    i++;

    let status: DiffFile["status"] = "modified";

    while (
      i < lines.length &&
      !lines[i].startsWith("---") &&
      !lines[i].startsWith("diff --git") &&
      !lines[i].startsWith("@@")
    ) {
      if (lines[i].startsWith("new file")) status = "added";
      else if (lines[i].startsWith("deleted file")) status = "deleted";
      else if (lines[i].startsWith("rename")) status = "renamed";
      i++;
    }

    if (i < lines.length && lines[i].startsWith("---")) {
      if (lines[i] === "--- /dev/null") status = "added";
      i++;
    }
    if (i < lines.length && lines[i].startsWith("+++")) {
      if (lines[i] === "+++ /dev/null") status = "deleted";
      i++;
    }

    const hunks: DiffHunk[] = [];

    while (i < lines.length && !lines[i].startsWith("diff --git")) {
      if (!lines[i].startsWith("@@")) {
        i++;
        continue;
      }

      const hunkMatch = lines[i].match(
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/,
      );
      if (!hunkMatch) {
        i++;
        continue;
      }

      const header = lines[i];
      const oldStart = parseInt(hunkMatch[1]);
      const newStart = parseInt(hunkMatch[3]);
      i++;

      let oldLine = oldStart;
      let newLine = newStart;
      const hunkLines: DiffLine[] = [];

      while (
        i < lines.length &&
        !lines[i].startsWith("@@") &&
        !lines[i].startsWith("diff --git")
      ) {
        const line = lines[i];
        if (line.startsWith("+")) {
          hunkLines.push({
            type: "addition",
            content: line.substring(1),
            newLine: newLine++,
          });
        } else if (line.startsWith("-")) {
          hunkLines.push({
            type: "deletion",
            content: line.substring(1),
            oldLine: oldLine++,
          });
        } else if (line.startsWith(" ") || line === "") {
          hunkLines.push({
            type: "context",
            content: line.length > 0 ? line.substring(1) : "",
            oldLine: oldLine++,
            newLine: newLine++,
          });
        } else if (line.startsWith("\\")) {
          // "\ No newline at end of file"
        } else {
          break;
        }
        i++;
      }

      hunks.push({ header, lines: hunkLines });
    }

    files.push({ oldPath, newPath, status, hunks });
  }

  return files;
}

export function countStats(files: DiffFile[]) {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type === "addition") additions++;
        else if (line.type === "deletion") deletions++;
      }
    }
  }
  return { additions, deletions };
}

export function fileStats(file: DiffFile) {
  let additions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.type === "addition") additions++;
      else if (line.type === "deletion") deletions++;
    }
  }
  return { additions, deletions };
}
