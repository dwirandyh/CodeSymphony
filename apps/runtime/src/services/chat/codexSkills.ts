import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { SlashCommand } from "@codesymphony/shared-types";

const SKILL_FILE_NAME = "SKILL.md";
const MAX_SCAN_DEPTH = 4;
const SKILL_COMMAND_TOKEN_REGEX = /(?<!\S)(?:\/|\$)(\w[\w-]*)(?=$|[\s.,!?;:])/g;

type CodexSkill = SlashCommand & {
  sortPriority: number;
};

function getCodexSkillCandidateRoots(worktreePath: string): string[] {
  return [
    join(worktreePath, ".agents/skills"),
    join(homedir(), ".codex/skills"),
    join(homedir(), ".agents/skills"),
  ];
}

function getClaudeSkillCandidateRoots(worktreePath: string): string[] {
  return [
    join(worktreePath, ".claude/skills"),
    join(homedir(), ".claude/skills"),
    ...getCodexSkillCandidateRoots(worktreePath),
  ];
}

function parseFrontmatterValue(frontmatter: string, key: string): string | null {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "im"));
  if (!match?.[1]) {
    return null;
  }

  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

function extractSkillMetadata(skillFilePath: string): Omit<CodexSkill, "sortPriority"> | null {
  try {
    const raw = readFileSync(skillFilePath, "utf8");
    const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---\n?/);
    const frontmatter = frontmatterMatch?.[1] ?? "";
    const skillDirName = basename(dirname(skillFilePath));
    const skillName = parseFrontmatterValue(frontmatter, "name") ?? skillDirName;
    const description = parseFrontmatterValue(frontmatter, "description")
      ?? raw
        .replace(/^---\n[\s\S]*?\n---\n?/m, "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.startsWith("#"))
      ?? "";

    if (!skillName.trim()) {
      return null;
    }

    return {
      name: skillName.trim(),
      description,
      argumentHint: "",
    };
  } catch {
    return null;
  }
}

function collectSkillFiles(rootPath: string, depth = 0): string[] {
  if (!existsSync(rootPath) || depth > MAX_SCAN_DEPTH) {
    return [];
  }

  let stats;
  try {
    stats = statSync(rootPath);
  } catch {
    return [];
  }

  if (!stats.isDirectory()) {
    return [];
  }

  const directSkillFilePath = join(rootPath, SKILL_FILE_NAME);
  if (existsSync(directSkillFilePath)) {
    return [directSkillFilePath];
  }

  let entries: string[] = [];
  try {
    entries = readdirSync(rootPath);
  } catch {
    return [];
  }

  return entries.flatMap((entry) => collectSkillFiles(join(rootPath, entry), depth + 1));
}

function listSkillsFromRoots(candidateRoots: string[]): SlashCommand[] {
  const deduped = new Map<string, CodexSkill>();

  candidateRoots.forEach((rootPath, rootIndex) => {
    for (const skillFilePath of collectSkillFiles(rootPath)) {
      const skill = extractSkillMetadata(skillFilePath);
      if (!skill) {
        continue;
      }

      const entry: CodexSkill = {
        ...skill,
        sortPriority: rootIndex,
      };
      const key = entry.name.toLowerCase();
      const existing = deduped.get(key);
      if (!existing || entry.sortPriority < existing.sortPriority) {
        deduped.set(key, entry);
      }
    }
  });

  return Array.from(deduped.values())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, description, argumentHint }) => ({ name, description, argumentHint }));
}

export function listCodexSkills(worktreePath: string): SlashCommand[] {
  return listSkillsFromRoots(getCodexSkillCandidateRoots(worktreePath));
}

export function listClaudeSkills(worktreePath: string): SlashCommand[] {
  return listSkillsFromRoots(getClaudeSkillCandidateRoots(worktreePath));
}

export function resolveCodexSkillCatalogCacheVersion(worktreePath: string): string {
  const hash = createHash("sha1");
  const skillFiles = getCodexSkillCandidateRoots(worktreePath)
    .flatMap((rootPath) => collectSkillFiles(rootPath))
    .sort((left, right) => left.localeCompare(right));

  if (skillFiles.length === 0) {
    hash.update("no-skills");
    return hash.digest("hex");
  }

  for (const skillFilePath of skillFiles) {
    try {
      const stats = statSync(skillFilePath);
      hash.update(skillFilePath);
      hash.update("\0");
      hash.update(String(stats.size));
      hash.update("\0");
      hash.update(String(stats.mtimeMs));
      hash.update("\0");
    } catch {
      hash.update(skillFilePath);
      hash.update("\0missing\0");
    }
  }

  return hash.digest("hex");
}

export type NormalizedSkillPrompt = {
  content: string;
  referencedSkills: string[];
};

export function normalizeSkillSlashCommandsForPrompt(content: string, skills: SlashCommand[]): NormalizedSkillPrompt {
  if (!content.trim()) {
    return { content, referencedSkills: [] };
  }

  const skillNamesByLowercase = new Map(
    skills.map((skill) => [skill.name.trim().toLowerCase(), skill.name.trim()] as const),
  );
  const referencedSkills: string[] = [];
  const strippedContent = content.replace(SKILL_COMMAND_TOKEN_REGEX, (match, rawName: string) => {
    const canonicalName = skillNamesByLowercase.get(rawName.toLowerCase());
    if (!canonicalName) {
      return match;
    }

    if (!referencedSkills.some((name) => name.toLowerCase() === canonicalName.toLowerCase())) {
      referencedSkills.push(canonicalName);
    }

    return "";
  });

  if (referencedSkills.length === 0) {
    return { content, referencedSkills: [] };
  }

  const instruction = referencedSkills.length === 1
    ? `Use $${referencedSkills[0]} for this task.`
    : `Use these skills for this task: ${referencedSkills.map((name) => `$${name}`).join(", ")}.`;
  const cleanedContent = strippedContent
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();

  return {
    content: cleanedContent.length > 0 ? `${instruction}\n\n${cleanedContent}` : instruction,
    referencedSkills,
  };
}

export function normalizeCodexSkillSlashCommandsForPrompt(content: string, skills: SlashCommand[]): string {
  return normalizeSkillSlashCommandsForPrompt(content, skills).content;
}

export function resolveClaudeSkillDirectory(worktreePath: string, skillName: string): string | null {
  const normalizedName = skillName.trim().toLowerCase();
  if (!normalizedName) {
    return null;
  }

  for (const rootPath of getClaudeSkillCandidateRoots(worktreePath)) {
    for (const skillFilePath of collectSkillFiles(rootPath)) {
      const skill = extractSkillMetadata(skillFilePath);
      if (skill?.name.trim().toLowerCase() === normalizedName) {
        return dirname(skillFilePath);
      }
    }
  }

  return null;
}

export function ensureProjectClaudeSkillLinks(worktreePath: string, skillNames: string[]): void {
  if (skillNames.length === 0) {
    return;
  }

  const projectSkillsDir = join(worktreePath, ".claude", "skills");
  mkdirSync(projectSkillsDir, { recursive: true });

  for (const skillName of skillNames) {
    const sourceDir = resolveClaudeSkillDirectory(worktreePath, skillName);
    if (!sourceDir) {
      continue;
    }

    const linkName = basename(sourceDir);
    const linkPath = join(projectSkillsDir, linkName);
    if (existsSync(linkPath)) {
      continue;
    }

    symlinkSync(sourceDir, linkPath);
  }
}