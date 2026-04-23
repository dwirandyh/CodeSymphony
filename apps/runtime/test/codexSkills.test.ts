import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listCodexSkills, normalizeCodexSkillSlashCommandsForPrompt } from "../src/services/chat/codexSkills.js";

describe("listCodexSkills", () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it("loads repo and home codex skills and prefers repo duplicates", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "codex-skills-"));
    const worktreePath = join(tempRoot, "repo");
    const homePath = join(tempRoot, "home");
    vi.stubEnv("HOME", homePath);

    mkdirSync(join(worktreePath, ".agents/skills/vercel-react-best-practices"), { recursive: true });
    mkdirSync(join(homePath, ".agents/skills/dogfood"), { recursive: true });
    mkdirSync(join(homePath, ".codex/skills/tools/excel"), { recursive: true });
    mkdirSync(join(homePath, ".codex/skills/duplicate/vercel-react-best-practices"), { recursive: true });

    writeFileSync(
      join(worktreePath, ".agents/skills/vercel-react-best-practices/SKILL.md"),
      "---\nname: vercel-react-best-practices\ndescription: Repo skill.\n---\n",
    );
    writeFileSync(
      join(homePath, ".agents/skills/dogfood/SKILL.md"),
      "---\nname: dogfood\ndescription: QA a web app.\n---\n",
    );
    writeFileSync(
      join(homePath, ".codex/skills/tools/excel/SKILL.md"),
      "---\nname: Excel\ndescription: Spreadsheet work.\n---\n",
    );
    writeFileSync(
      join(homePath, ".codex/skills/duplicate/vercel-react-best-practices/SKILL.md"),
      "---\nname: vercel-react-best-practices\ndescription: Home duplicate.\n---\n",
    );

    const skills = listCodexSkills(worktreePath);

    expect(skills.some((skill) => skill.name === "vercel-react-best-practices")).toBe(true);
    expect(skills.some((skill) => skill.name === "dogfood")).toBe(true);
    expect(skills.some((skill) => skill.name === "Excel")).toBe(true);
    expect(skills.filter((skill) => skill.name.toLowerCase() === "vercel-react-best-practices")).toHaveLength(1);
  });
});

describe("normalizeCodexSkillSlashCommandsForPrompt", () => {
  const skills = [
    { name: "dogfood", description: "QA a web app", argumentHint: "" },
    { name: "Excel", description: "Spreadsheet work", argumentHint: "" },
  ];

  it("turns skill slash commands into an explicit Codex instruction", () => {
    expect(normalizeCodexSkillSlashCommandsForPrompt("/dogfood audit halaman settings", skills)).toBe(
      "Use $dogfood for this task.\n\naudit halaman settings",
    );
  });

  it("supports multiple skills and preserves non-skill slash tokens", () => {
    expect(normalizeCodexSkillSlashCommandsForPrompt("/dogfood pakai /Users/test dan /Excel", skills)).toBe(
      "Use these skills for this task: $dogfood, $Excel.\n\npakai /Users/test dan",
    );
  });

  it("keeps content unchanged when no listed skills are invoked", () => {
    expect(normalizeCodexSkillSlashCommandsForPrompt("/commit review changes", skills)).toBe("/commit review changes");
  });
});
