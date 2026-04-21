import { describe, expect, it } from "vitest";
import {
  buildCodexPlanMarkdown,
  resolveCodexPlanContent,
  resolveCodexRuntimePolicy,
  selectPrimaryCodexFileChange,
} from "../src/codex/sessionRunner";

describe("codex session runner plan helpers", () => {
  it("formats structured plans into actionable markdown", () => {
    expect(buildCodexPlanMarkdown({
      explanation: "Ship the Codex selector without regressing Claude parity.",
      steps: [
        { step: "Update the runtime approval flow", status: "completed" },
        { step: "Patch the composer and settings UI", status: "inProgress" },
        { step: "Dogfood the end-to-end thread flow", status: "pending" },
      ],
    })).toBe(
      [
        "Ship the Codex selector without regressing Claude parity.",
        "",
        "1. Update the runtime approval flow (completed)",
        "2. Patch the composer and settings UI (in progress)",
        "3. Dogfood the end-to-end thread flow",
      ].join("\n"),
    );
  });

  it("drops boilerplate-only plans", () => {
    expect(buildCodexPlanMarkdown({
      explanation: "Reply with approval to execute the plan.",
      steps: [{ step: "   ", status: "pending" }],
    })).toBeNull();
  });

  it("falls back to the proposed_plan block in agent output", () => {
    expect(resolveCodexPlanContent({
      planText: "Reply with approval if you want me to execute it.",
      agentOutput: [
        "Here is the plan.",
        "<proposed_plan>",
        "1. Reproduce the failure locally",
        "2. Patch the failing selector flow",
        "3. Re-run plan mode dogfood",
        "</proposed_plan>",
        "Reply with approval if you want me to execute it.",
      ].join("\n"),
    })).toBe(
      [
        "1. Reproduce the failure locally",
        "2. Patch the failing selector flow",
        "3. Re-run plan mode dogfood",
      ].join("\n"),
    );
  });

  it("uses on-request approvals for default and plan-mode Codex threads", () => {
    expect(resolveCodexRuntimePolicy({
      permissionMode: "default",
      threadPermissionMode: "default",
    })).toEqual({
      approvalPolicy: "on-request",
      sandbox: "read-only",
    });

    expect(resolveCodexRuntimePolicy({
      permissionMode: "plan",
      threadPermissionMode: "full_access",
    })).toEqual({
      approvalPolicy: "on-request",
      sandbox: "read-only",
    });

    expect(resolveCodexRuntimePolicy({
      permissionMode: "default",
      threadPermissionMode: "full_access",
    })).toEqual({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });

  it("prefers the user-facing file over codex permission probes in multi-file changes", () => {
    expect(selectPrimaryCodexFileChange({
      changes: [
        {
          path: "/Users/dwirandyh/Work/Personal/codesymphony/.codex-permission-probe",
          kind: { type: "delete" },
        },
        {
          path: "/Users/dwirandyh/Work/Personal/codesymphony/dogfood-permission-test-7.txt",
          kind: { type: "add" },
        },
      ],
    })).toEqual({
      path: "/Users/dwirandyh/Work/Personal/codesymphony/dogfood-permission-test-7.txt",
      kind: "add",
    });
  });
});
