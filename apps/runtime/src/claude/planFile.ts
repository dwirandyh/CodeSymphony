import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

function scanPlanDir(dir: string, afterTimestamp: number): { filePath: string; mtime: number } | null {
    if (!existsSync(dir)) return null;
    let latest: { filePath: string; mtime: number } | null = null;
    try {
        for (const entry of readdirSync(dir)) {
            if (!entry.endsWith(".md")) continue;
            const filePath = join(dir, entry);
            const stat = statSync(filePath);
            if (stat.mtimeMs > afterTimestamp && (!latest || stat.mtimeMs > latest.mtime)) {
                latest = { filePath, mtime: stat.mtimeMs };
            }
        }
    } catch { /* skip unreadable dirs */ }
    return latest;
}

export function findLatestPlanFile(afterTimestamp: number): { filePath: string; content: string } | null {
    const candidates = [
        scanPlanDir(join(homedir(), ".claude", "plans"), afterTimestamp),
        scanPlanDir(join(tmpdir(), "codesymphony-claude-provider", "plans"), afterTimestamp),
    ].filter(Boolean) as { filePath: string; mtime: number }[];

    candidates.sort((a, b) => b.mtime - a.mtime);
    const latestFile = candidates[0] ?? null;

    if (!latestFile) return null;

    try {
        const content = readFileSync(latestFile.filePath, "utf-8");
        return content.trim().length > 0 ? { filePath: latestFile.filePath, content } : null;
    } catch {
        return null;
    }
}
