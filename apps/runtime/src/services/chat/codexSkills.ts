import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { SlashCommand } from "@codesymphony/shared-types";

const SKILL_FILE_NAME = "SKILL.md";
const MAX_SCAN_DEPTH = 4;
const SKILL_COMMAND_TOKEN_REGEX = /(?<!\S)(?:\/|\$)(\w[\w-]*)(?=$|[\s.,!?;:])/g;

type CodexSkill = SlashCommand & {
  sortPriority: number;
};

function parseFrontmatterValue(frontmatter: string, key: string): string | null {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "im"));
  if (!match?.[1]) {
    return null;
  }

  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

function extractSkillMetadata(skillFilePath: string): CodexSkill | null {
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
      sortPriority: skillFilePath.includes("/.agents/skills/") ? 0 : 1,
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

export function listCodexSkills(worktreePath: string): SlashCommand[] {
  const candidateRoots = [
    join(worktreePath, ".agents/skills"),
    join(homedir(), ".codex/skills"),
    join(homedir(), ".agents/skills"),
  ];

  const deduped = new Map<string, CodexSkill>();

  for (const rootPath of candidateRoots) {
    for (const skillFilePath of collectSkillFiles(rootPath)) {
      const skill = extractSkillMetadata(skillFilePath);
      if (!skill) {
        continue;
      }

      const key = skill.name.toLowerCase();
      const existing = deduped.get(key);
      if (!existing || skill.sortPriority < existing.sortPriority) {
        deduped.set(key, skill);
      }
    }
  }

  return Array.from(deduped.values())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, description, argumentHint }) => ({ name, description, argumentHint }));
}

export function normalizeCodexSkillSlashCommandsForPrompt(content: string, skills: SlashCommand[]): string {
  if (!content.trim()) {
    return content;
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
    return content;
  }

  const instruction = referencedSkills.length === 1
    ? `Use $${referencedSkills[0]} for this task.`
    : `Use these skills for this task: ${referencedSkills.map((name) => `$${name}`).join(", ")}.`;
  const cleanedContent = strippedContent
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();

  return cleanedContent.length > 0 ? `${instruction}\n\n${cleanedContent}` : instruction;
}
