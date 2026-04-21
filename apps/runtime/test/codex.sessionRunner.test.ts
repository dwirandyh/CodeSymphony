import { describe, expect, it } from "vitest";
import {
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
  buildCodexPlanMarkdown,
  requestedPermissionsIncludeFileWrite,
  resolveCodexPlanContent,
  resolveCodexRuntimePolicy,
  selectPrimaryCodexFileChange,
  shouldAutoDeclineCodexPlanApproval,
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

  it("allows non-mutating exploration in Codex plan mode instructions", () => {
    expect(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS).toContain("You may explore and execute non-mutating actions that improve the plan.");
    expect(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS).toContain("Read or search files, configs, manifests, and docs.");
    expect(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS).not.toContain("Do not read files or use tools.");
  });

  it("detects when requested Codex permissions include file writes", () => {
    expect(requestedPermissionsIncludeFileWrite({
      fileSystem: {
        write: ["/tmp/output.txt"],
      },
    })).toBe(true);

    expect(requestedPermissionsIncludeFileWrite({
      fileSystem: {
        read: ["/tmp/input.txt"],
      },
    })).toBe(false);
  });

  it("only auto-declines mutating Codex approvals in plan mode", () => {
    expect(shouldAutoDeclineCodexPlanApproval({
      permissionMode: "plan",
      requestMethod: "item/fileRead/requestApproval",
    })).toBe(false);

    expect(shouldAutoDeclineCodexPlanApproval({
      permissionMode: "plan",
      requestMethod: "item/commandExecution/requestApproval",
    })).toBe(false);

    expect(shouldAutoDeclineCodexPlanApproval({
      permissionMode: "plan",
      requestMethod: "item/fileChange/requestApproval",
    })).toBe(true);

    expect(shouldAutoDeclineCodexPlanApproval({
      permissionMode: "plan",
      requestMethod: "item/permissions/requestApproval",
      requestedPermissions: {
        fileSystem: {
          write: ["/tmp/output.txt"],
        },
      },
    })).toBe(true);
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
