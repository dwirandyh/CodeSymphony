import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type CodexCliProviderOverride = {
  configPath: string;
  providerId: string;
  providerName: string;
  baseUrl: string | null;
  model: string | null;
  wireApi: string | null;
};

type ParsedTomlConfig = {
  globals: Map<string, string>;
  sections: Map<string, Map<string, string>>;
};

function resolveCodexConfigPath(env: NodeJS.ProcessEnv): string {
  const configuredHome = env.CODEX_HOME?.trim();
  const codexHome = configuredHome && configuredHome.length > 0
    ? configuredHome
    : join(homedir(), ".codex");
  return join(codexHome, "config.toml");
}

function stripInlineComment(line: string): string {
  let result = "";
  let quote: "\"" | "'" | null = null;
  let escaped = false;

  for (const char of line) {
    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }

    if (quote === "\"") {
      result += char;
      if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        quote = null;
      }
      continue;
    }

    if (quote === "'") {
      result += char;
      if (char === "'") {
        quote = null;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      result += char;
      continue;
    }

    if (char === "#") {
      break;
    }

    result += char;
  }

  return result.trim();
}

function parseTomlString(rawValue: string): string | null {
  const trimmedValue = rawValue.trim();
  if (trimmedValue.length === 0) {
    return null;
  }

  if (trimmedValue.startsWith("\"")) {
    try {
      const parsed = JSON.parse(trimmedValue);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  if (trimmedValue.startsWith("'") && trimmedValue.endsWith("'")) {
    return trimmedValue.slice(1, -1);
  }

  return trimmedValue;
}

function parseCodexTomlConfig(content: string): ParsedTomlConfig {
  const globals = new Map<string, string>();
  const sections = new Map<string, Map<string, string>>();
  let currentSection: string | null = null;

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = stripInlineComment(rawLine);
    if (line.length === 0) {
      continue;
    }

    if (line.startsWith("[") && line.endsWith("]")) {
      currentSection = line.slice(1, -1).trim();
      if (currentSection.length > 0 && !sections.has(currentSection)) {
        sections.set(currentSection, new Map<string, string>());
      }
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    const parsedValue = parseTomlString(line.slice(equalsIndex + 1));
    if (!key || parsedValue == null) {
      continue;
    }

    if (currentSection) {
      const sectionValues = sections.get(currentSection) ?? new Map<string, string>();
      sectionValues.set(key, parsedValue);
      sections.set(currentSection, sectionValues);
    } else {
      globals.set(key, parsedValue);
    }
  }

  return { globals, sections };
}

export function resolveCodexCliProviderOverride(env: NodeJS.ProcessEnv = process.env): CodexCliProviderOverride | null {
  const configPath = resolveCodexConfigPath(env);
  if (!existsSync(configPath)) {
    return null;
  }

  let parsedConfig: ParsedTomlConfig;
  try {
    parsedConfig = parseCodexTomlConfig(readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }

  const providerId = parsedConfig.globals.get("model_provider")?.trim();
  if (!providerId) {
    return null;
  }

  const providerSection = parsedConfig.sections.get(`model_providers.${providerId}`);
  return {
    configPath,
    providerId,
    providerName: providerSection?.get("name")?.trim() || providerId,
    baseUrl: providerSection?.get("base_url")?.trim() || null,
    model: parsedConfig.globals.get("model")?.trim() || null,
    wireApi: providerSection?.get("wire_api")?.trim() || null,
  };
}

export function buildCodexCliProviderHint(env: NodeJS.ProcessEnv = process.env): string | null {
  const providerOverride = resolveCodexCliProviderOverride(env);
  if (!providerOverride) {
    return null;
  }

  const providerLocation = providerOverride.baseUrl ?? "configured default endpoint";
  const wireApiDetail = providerOverride.wireApi ? ` using ${providerOverride.wireApi}` : "";
  const modelDetail = providerOverride.model ? ` CLI default model is "${providerOverride.model}".` : "";

  return `Effective Codex CLI provider: "${providerOverride.providerName}" via ${providerLocation}${wireApiDetail}.`
    + `${modelDetail}\nThis comes from ${providerOverride.configPath}, not Settings → Models.`;
}

export const __testing = {
  parseCodexTomlConfig,
  parseTomlString,
  stripInlineComment,
};
