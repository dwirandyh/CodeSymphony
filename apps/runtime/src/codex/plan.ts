import { asArray, asObject, asString } from "./protocolUtils.js";

export const PLAN_FILE_PATH = ".claude/plans/codex-plan.md";

const PROPOSED_PLAN_BLOCK_REGEX = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;
const PLAN_APPROVAL_BOILERPLATE_PATTERNS = [
  /^reply with approval if you want me to execute it\.?$/gim,
  /^reply with approval to execute(?: the plan)?\.?$/gim,
  /^approve this plan to continue\.?$/gim,
  /^let me know if you want me to proceed\.?$/gim,
];

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

function normalizePlanCandidate(text: string | null | undefined): string | null {
  const proposedPlan = extractProposedPlanMarkdown(text ?? undefined);
  const candidate = stripPlanApprovalBoilerplate((proposedPlan ?? text ?? "").trim());
  return candidate.length > 0 ? candidate : null;
}

function hasActionablePlanContent(text: string | null | undefined): boolean {
  const candidate = normalizePlanCandidate(text);
  if (!candidate) {
    return false;
  }

  const lines = candidate
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const listLines = lines.filter((line) => /^([-*]|\d+\.)\s+/.test(line));

  if (listLines.length >= 2) {
    return true;
  }

  if (lines.some((line) => /^#{1,6}\s+\S+/.test(line)) && lines.length >= 2) {
    return true;
  }

  return candidate.length >= 120 && lines.length >= 3;
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
  return hasActionablePlanContent(content) ? content : null;
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

export function resolveCodexPlanContent(input: {
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
    if (hasActionablePlanContent(candidate)) {
      return candidate;
    }
  }

  return null;
}
