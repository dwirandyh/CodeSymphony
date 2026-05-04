import { asArray, asObject, asString } from "./protocolUtils.js";

export const PLAN_FILE_PATH = ".claude/plans/codex-plan.md";

const PROPOSED_PLAN_BLOCK_REGEX = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;
const PLAN_APPROVAL_BOILERPLATE_PATTERNS = [
  /^reply with approval if you want me to execute it\.?$/gim,
  /^reply with approval to execute(?: the plan)?\.?$/gim,
  /^approve this plan to continue\.?$/gim,
  /^let me know if you want me to proceed\.?$/gim,
];
const TRAILING_APPROVAL_PROMPT_LINE_PATTERN = /^(apakah saya harus lanjut|apakah ada yang ingin|should i continue|would you like me to continue|do you want me to continue|is there anything (?:else )?(?:you'd|you would) like)/i;

export type CodexPlanStep = {
  step: string;
  status: "pending" | "inProgress" | "completed";
};

export type CodexStructuredPlan = {
  explanation: string | null;
  steps: CodexPlanStep[];
};

function extractProposedPlanMarkdown(text: string | undefined): string | undefined {
  const match = text ? PROPOSED_PLAN_BLOCK_REGEX.exec(text) : null;
  const planMarkdown = match?.[1]?.trim();
  return planMarkdown && planMarkdown.length > 0 ? planMarkdown : undefined;
}

function stripPlanApprovalBoilerplate(text: string): string {
  let normalized = text;
  for (const pattern of PLAN_APPROVAL_BOILERPLATE_PATTERNS) {
    normalized = normalized.replace(pattern, "");
  }
  return normalized
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripTrailingApprovalPrompt(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd());
  let cutIndex = lines.length;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.length === 0) {
      continue;
    }
    if (TRAILING_APPROVAL_PROMPT_LINE_PATTERN.test(line)) {
      cutIndex = index;
      continue;
    }
    break;
  }

  return lines
    .slice(0, cutIndex)
    .join("\n")
    .replace(/\n(?:---|\*\*\*)\s*$/g, "")
    .trim();
}

function normalizePlanCandidate(text: string | null | undefined): string | null {
  const proposedPlan = extractProposedPlanMarkdown(text ?? undefined);
  const candidate = stripTrailingApprovalPrompt(
    stripPlanApprovalBoilerplate((proposedPlan ?? text ?? "").trim()),
  );
  return candidate.length > 0 ? candidate : null;
}

export function isReviewableCodexPlanContent(text: string | null | undefined): boolean {
  const candidate = normalizePlanCandidate(text);
  if (!candidate) {
    return false;
  }

  const lines = candidate
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const numberedListLines = lines.filter((line) => /^\d+\.\s+/.test(line));
  const bulletListLines = lines.filter((line) => /^[-*]\s+/.test(line));
  const hasHeading = lines.some((line) => /^#{1,6}\s+\S+/.test(line));

  if (numberedListLines.length >= 2) {
    return true;
  }

  if (hasHeading && (numberedListLines.length + bulletListLines.length) >= 1) {
    return true;
  }

  return false;
}

export function isClarificationShapedPlanCandidate(text: string | null | undefined): boolean {
  const candidate = normalizePlanCandidate(text);
  if (!candidate) {
    return false;
  }

  const lines = candidate
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const numberedListLines = lines.filter((line) => /^\d+\.\s+/.test(line));
  const firstLine = lines[0] ?? "";
  const firstTwoLines = lines.slice(0, 2).join(" ");
  const bulletListLines = lines.filter((line) => /^[-*]\s+/.test(line));
  const hasClarifyingHeading = lines.some((line) => /^#{1,6}\s+.*question\b/i.test(line));
  const hasClarificationPrompt = lines.some((line) =>
    /\b(clarifying question|need clarification|butuh klarifikasi|which is it|what specific|what do you mean|can you clarify|bisa jelaskan|apa yang dimaksud|sebelum menyusun rencana)\b/i.test(
      line,
    )
    || /\?\s*$/.test(line),
  );
  const hasQuestionLead = hasClarifyingHeading
    || /^question\b/i.test(firstLine)
    || hasClarificationPrompt
    || firstTwoLines.includes("?");
  const hasRecommendationLine = lines.some((line) => /^recommended answer\b\s*:?/i.test(line));
  const optionBulletCount = lines.filter((line) => /^[-*]\s+option\b/i.test(line)).length;

  return hasQuestionLead
    && (
      hasRecommendationLine
      || optionBulletCount >= 2
      || bulletListLines.length >= 2
      || numberedListLines.length >= 2
    );
}

export function buildCodexPlanMarkdown(plan: CodexStructuredPlan | null | undefined): string | null {
  if (!plan) {
    return null;
  }

  const lines: string[] = [];
  const explanation = normalizePlanCandidate(plan.explanation);
  if (explanation) {
    lines.push(explanation);
  }

  const formattedSteps = plan.steps
    .map((entry, index) => {
      const step = entry.step.trim();
      if (!step) {
        return null;
      }
      const suffix = entry.status === "completed"
        ? " (completed)"
        : entry.status === "inProgress"
          ? " (in progress)"
          : "";
      return `${index + 1}. ${step}${suffix}`;
    })
    .filter((entry): entry is string => entry !== null);

  if (formattedSteps.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(...formattedSteps);
  }

  const content = lines.join("\n").trim();
  return isReviewableCodexPlanContent(content) ? content : null;
}

export function findPlanTextInTurn(turn: Record<string, unknown> | undefined): string | null {
  const items = asArray(turn?.items)
    .map(asObject)
    .filter((entry): entry is Record<string, unknown> => entry !== undefined);

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const itemType = asString(item?.type)?.trim().toLowerCase();
    if (itemType !== "plan") {
      continue;
    }

    const text = asString(item?.text)?.trim();
    if (text && text.length > 0) {
      return text;
    }
  }

  return null;
}

export function resolveHeuristicPlanContent(input: {
  planText?: string | null;
  structuredPlan?: CodexStructuredPlan | null;
  agentOutput?: string | null;
}): string | null {
  const candidates = [
    normalizePlanCandidate(input.planText),
    buildCodexPlanMarkdown(input.structuredPlan),
    normalizePlanCandidate(input.agentOutput),
  ];

  for (const candidate of candidates) {
    if (isClarificationShapedPlanCandidate(candidate)) {
      continue;
    }
    if (isReviewableCodexPlanContent(candidate)) {
      return candidate;
    }
  }

  return null;
}

// Backward-compatible alias for runners that still import the older helper name.
export const resolveCodexPlanContent = resolveHeuristicPlanContent;

export function resolveExplicitCodexPlanContent(input: {
  planText?: string | null;
  structuredPlan?: CodexStructuredPlan | null;
  agentOutput?: string | null;
}): string | null {
  const explicitAgentOutput = extractProposedPlanMarkdown(input.agentOutput ?? undefined);
  const candidates = [
    normalizePlanCandidate(input.planText),
    buildCodexPlanMarkdown(input.structuredPlan),
    normalizePlanCandidate(explicitAgentOutput),
  ];

  for (const candidate of candidates) {
    if (isReviewableCodexPlanContent(candidate)) {
      return candidate;
    }
  }

  return null;
}
