import { existsSync, lstatSync, mkdtempSync, mkdirSync, readlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureProjectClaudeSkillLinks,
  listClaudeSkills,
  listCodexSkills,
  normalizeCodexSkillSlashCommandsForPrompt,
  normalizeSkillSlashCommandsForPrompt,
  resolveCodexSkillCatalogCacheVersion,
} from "../src/services/chat/codexSkills.js";

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

  it("changes the cache version when a tracked skill file changes", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "codex-skills-"));
    const worktreePath = join(tempRoot, "repo");
    const homePath = join(tempRoot, "home");
    vi.stubEnv("HOME", homePath);

    mkdirSync(join(worktreePath, ".agents/skills/dogfood"), { recursive: true });
    const skillFilePath = join(worktreePath, ".agents/skills/dogfood/SKILL.md");
    writeFileSync(
      skillFilePath,
      "---\nname: dogfood\ndescription: QA a web app.\n---\n",
    );

    const firstVersion = resolveCodexSkillCatalogCacheVersion(worktreePath);
    writeFileSync(
      skillFilePath,
      "---\nname: dogfood\ndescription: QA the settings page.\n---\n",
    );

    const secondVersion = resolveCodexSkillCatalogCacheVersion(worktreePath);

    expect(secondVersion).not.toBe(firstVersion);
  });
});

describe("listClaudeSkills", () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it("loads home and project Claude skills from ~/.claude/skills", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "claude-skills-"));
    const worktreePath = join(tempRoot, "repo");
    const homePath = join(tempRoot, "home");
    vi.stubEnv("HOME", homePath);

    mkdirSync(join(worktreePath, ".claude/skills/diagnose"), { recursive: true });
    mkdirSync(join(homePath, ".claude/skills/grill-with-docs"), { recursive: true });
    writeFileSync(
      join(worktreePath, ".claude/skills/diagnose/SKILL.md"),
      "---\nname: diagnose\ndescription: Diagnose hard bugs.\n---\n",
    );
    writeFileSync(
      join(homePath, ".claude/skills/grill-with-docs/SKILL.md"),
      "---\nname: grill-with-docs\ndescription: Grill a plan against docs.\n---\n",
    );

    const skills = listClaudeSkills(worktreePath);

    expect(skills.some((skill) => skill.name === "diagnose")).toBe(true);
    expect(skills.some((skill) => skill.name === "grill-with-docs")).toBe(true);
    expect(skills.filter((skill) => skill.name.toLowerCase() === "diagnose")).toHaveLength(1);
  });
});

describe("ensureProjectClaudeSkillLinks", () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it("links home Claude skills into the worktree project scope", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "claude-skill-links-"));
    const worktreePath = join(tempRoot, "repo");
    const homePath = join(tempRoot, "home");
    vi.stubEnv("HOME", homePath);

    const homeSkillDir = join(homePath, ".claude/skills/diagnose");
    mkdirSync(homeSkillDir, { recursive: true });
    writeFileSync(
      join(homeSkillDir, "SKILL.md"),
      "---\nname: diagnose\ndescription: Diagnose hard bugs.\n---\n",
    );

    ensureProjectClaudeSkillLinks(worktreePath, ["diagnose"]);

    const linkPath = join(worktreePath, ".claude/skills/diagnose");
    expect(existsSync(linkPath)).toBe(true);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(homeSkillDir);
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

  it("accepts $skill aliases without changing the resulting Codex instruction", () => {
    expect(normalizeCodexSkillSlashCommandsForPrompt("$dogfood audit halaman settings", skills)).toBe(
      "Use $dogfood for this task.\n\naudit halaman settings",
    );
  });

  it("supports multiple skills and preserves non-skill slash tokens", () => {
    expect(normalizeCodexSkillSlashCommandsForPrompt("/dogfood pakai /Users/test dan $Excel", skills)).toBe(
      "Use these skills for this task: $dogfood, $Excel.\n\npakai /Users/test dan",
    );
  });

  it("keeps content unchanged when no listed skills are invoked", () => {
    expect(normalizeCodexSkillSlashCommandsForPrompt("/commit review changes", skills)).toBe("/commit review changes");
  });

  it("returns referenced skill names for project linking", () => {
    expect(normalizeSkillSlashCommandsForPrompt("/dogfood audit settings", skills)).toEqual({
      content: "Use $dogfood for this task.\n\naudit settings",
      referencedSkills: ["dogfood"],
    });
  });
});
