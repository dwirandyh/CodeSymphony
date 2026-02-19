import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function findLatestPlanFile(afterTimestamp: number): { filePath: string; content: string } | null {
    const plansDir = join(homedir(), ".claude", "plans");
    if (!existsSync(plansDir)) {
        return null;
    }

    let latestFile: { filePath: string; mtime: number } | null = null;
    try {
        const entries = readdirSync(plansDir);
        for (const entry of entries) {
            if (!entry.endsWith(".md")) {
                continue;
            }
            const filePath = join(plansDir, entry);
            const stat = statSync(filePath);
            if (stat.mtimeMs > afterTimestamp && (!latestFile || stat.mtimeMs > latestFile.mtime)) {
                latestFile = { filePath, mtime: stat.mtimeMs };
            }
        }
    } catch {
        return null;
    }

    if (!latestFile) {
        return null;
    }

    try {
        const content = readFileSync(latestFile.filePath, "utf-8");
        return content.trim().length > 0 ? { filePath: latestFile.filePath, content } : null;
    } catch {
        return null;
    }
}
