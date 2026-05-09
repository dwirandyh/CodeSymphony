import { describe, expect, it } from "vitest";
import {
  buildCollaborationMode,
  buildCodexPlanMarkdown,
  resolveExplicitCodexPlanContent,
  resolveHeuristicPlanContent,
  requestedPermissionsIncludeFileWrite,
  resolveCodexPlanContent,
  resolveCodexRuntimePolicy,
  selectPrimaryCodexFileChange,
  shouldAutoDeclineCodexPlanApproval,
} from "../src/codex/sessionRunner";
import { classifyFileChange } from "../src/codex/toolContext";

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
    expect(resolveHeuristicPlanContent({
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

  it("does not treat clarification questions as a reviewable plan", () => {
    expect(resolveHeuristicPlanContent({
      planText: [
        "Question 1: should the mobile app call the start endpoint immediately?",
        "",
        "Recommended answer: yes.",
        "",
        "The branch I want to close:",
        "- Option A: unify start behavior around the backend response.",
        "- Option B: keep the existing picker for first-time play.",
        "",
        "Which is it?",
      ].join("\n"),
    })).toBeNull();
  });

  it("does not treat heading-plus-options clarifications as heuristic plans", () => {
    expect(resolveHeuristicPlanContent({
      agentOutput: [
        "### Clarifying Question",
        "",
        "What specific handoff are you referring to?",
        "",
        "Recommended answer:",
        "- A code/task handoff from another human",
        "- An existing codebase change or pull request I should review",
      ].join("\n"),
    })).toBeNull();
  });

  it("does not treat numbered clarification options as a reviewable plan", () => {
    expect(resolveHeuristicPlanContent({
      agentOutput: [
        "Saya akan menganalisis codebase untuk memahami implementasi plan card dan membuat rencana perbaikan.",
        "",
        "Saya tidak menemukan implementasi \"OpenCode plan card\" di repo Flutter ini. Sebelum menyusun rencana, bisa jelaskan:",
        "",
        "**Apa yang dimaksud dengan \"OpenCode plan card\" di konteks ini?**",
        "",
        "1. Konfigurasi agent/prompt OpenCode di repo ini yang perlu diperbaiki?",
        "2. Fitur di dalam Flutter app yang menampilkan plan card dari AI?",
        "3. Atau sesuatu yang berbeda?",
      ].join("\n"),
    })).toBeNull();
  });

  it("keeps final plans when OpenCode appends a trailing approval question", () => {
    expect(resolveHeuristicPlanContent({
      agentOutput: [
        "Berdasarkan analisis codebase, saya sudah memahami masalah dan solusinya. Berikut implementation plan:",
        "",
        "---",
        "",
        "## Implementation Plan: Perbaiki False Positive Plan Card saat Assistant Hanya Bertanya Klarifikasi",
        "",
        "### Masalah Inti",
        "",
        "1. Ketatkan classifier klarifikasi pada fallback plan detection.",
        "2. Sinkronkan filter di web dan chat-timeline-core.",
        "3. Tambahkan regression test untuk clarification-shaped outputs.",
        "",
        "---",
        "",
        "Apakah saya harus lanjut ke implementation, atau ada yang ingin ditanyakan/diklarifikasi dulu?",
      ].join("\n"),
    })).toBe(
      [
        "Berdasarkan analisis codebase, saya sudah memahami masalah dan solusinya. Berikut implementation plan:",
        "",
        "---",
        "",
        "## Implementation Plan: Perbaiki False Positive Plan Card saat Assistant Hanya Bertanya Klarifikasi",
        "",
        "### Masalah Inti",
        "",
        "1. Ketatkan classifier klarifikasi pada fallback plan detection.",
        "2. Sinkronkan filter di web dan chat-timeline-core.",
        "3. Tambahkan regression test untuk clarification-shaped outputs.",
      ].join("\n"),
    );
  });

  it("keeps resolveCodexPlanContent as a compatibility alias", () => {
    expect(resolveCodexPlanContent({
      agentOutput: [
        "<proposed_plan>",
        "1. Inspect the failing route",
        "2. Patch the handler",
        "3. Re-run the tests",
        "</proposed_plan>",
      ].join("\n"),
    })).toBe(resolveHeuristicPlanContent({
      agentOutput: [
        "<proposed_plan>",
        "1. Inspect the failing route",
        "2. Patch the handler",
        "3. Re-run the tests",
        "</proposed_plan>",
      ].join("\n"),
    }));
  });

  it("prefers the raw Codex final answer when it already contains a reviewable plan", () => {
    expect(resolveExplicitCodexPlanContent({
      planText: [
        "1. Inspect the failing route",
        "2. Patch the handler",
        "3. Re-run the tests",
      ].join("\n"),
      agentOutput: [
        "**Plan**",
        "1. Inspect the failing route",
        "2. Patch the handler",
        "3. Re-run the tests",
        "",
        "Kalau mau, next saya langsung eksekusi plan ini.",
      ].join("\n"),
    })).toBe(
      [
        "**Plan**",
        "1. Inspect the failing route",
        "2. Patch the handler",
        "3. Re-run the tests",
        "",
        "Kalau mau, next saya langsung eksekusi plan ini.",
      ].join("\n"),
    );
  });

  it("keeps raw Codex plan item text verbatim", () => {
    expect(resolveExplicitCodexPlanContent({
      planText: [
        "**Plan**",
        "1. Inspect the failing route",
        "2. Patch the handler",
        "3. Re-run the tests",
        "",
        "Kalau mau, next saya langsung eksekusi plan ini.",
      ].join("\n"),
    })).toBe(
      [
        "**Plan**",
        "1. Inspect the failing route",
        "2. Patch the handler",
        "3. Re-run the tests",
        "",
        "Kalau mau, next saya langsung eksekusi plan ini.",
      ].join("\n"),
    );
  });

  it("falls back to raw Codex agent output when no explicit plan item exists", () => {
    expect(resolveExplicitCodexPlanContent({
      agentOutput: [
        "**Plan**",
        "1. Inspect the failing route",
        "2. Patch the handler",
        "3. Re-run the tests",
        "",
        "Kalau mau, next saya langsung eksekusi plan ini.",
      ].join("\n"),
    })).toBe(
      [
        "**Plan**",
        "1. Inspect the failing route",
        "2. Patch the handler",
        "3. Re-run the tests",
        "",
        "Kalau mau, next saya langsung eksekusi plan ini.",
      ].join("\n"),
    );
  });

  it("does not misclassify inline code question marks as clarification prompts", () => {
    expect(resolveExplicitCodexPlanContent({
      agentOutput: [
        "Plan perubahan ke `scratch_at`:",
        "",
        "1. Rapikan tipe `scratchAt` yang masih `Any?`.",
        "2. Ganti binding dari `updatedAt` ke `scratchAt`.",
        "3. Tambahkan fallback saat `scratchAt` kosong.",
      ].join("\n"),
    })).toBe(
      [
        "Plan perubahan ke `scratch_at`:",
        "",
        "1. Rapikan tipe `scratchAt` yang masih `Any?`.",
        "2. Ganti binding dari `updatedAt` ke `scratchAt`.",
        "3. Tambahkan fallback saat `scratchAt` kosong.",
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

  it("matches Codex collaboration mode presets instead of injecting custom instructions", () => {
    expect(buildCollaborationMode("gpt-5.4", "plan")).toEqual({
      mode: "plan",
      settings: {
        model: "gpt-5.4",
        reasoning_effort: "medium",
        developer_instructions: null,
      },
    });

    expect(buildCollaborationMode("gpt-5.4", "default")).toEqual({
      mode: "default",
      settings: {
        model: "gpt-5.4",
        reasoning_effort: null,
        developer_instructions: null,
      },
    });
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
    })).toMatchObject({
      path: "/Users/dwirandyh/Work/Personal/codesymphony/dogfood-permission-test-7.txt",
      kind: "add",
    });
  });

  it("preserves diff-like file change payload fields when Codex provides them", () => {
    expect(classifyFileChange({
      changes: [
        {
          path: "/tmp/example.txt",
          kind: {
            type: "update",
          },
          old_string: "before",
          new_string: "after",
          edits: [{ old_string: "before", new_string: "after" }],
        },
      ],
    }, null)).toMatchObject({
      toolName: "Edit",
      editTarget: "/tmp/example.txt",
      toolInput: {
        file_path: "/tmp/example.txt",
        old_string: "before",
        new_string: "after",
        edits: [{ old_string: "before", new_string: "after" }],
      },
    });

    expect(classifyFileChange({
      changes: [
        {
          path: "/tmp/new-file.txt",
          kind: {
            type: "add",
            newContent: "hello world",
          },
        },
      ],
    }, null)).toMatchObject({
      toolName: "Write",
      editTarget: "/tmp/new-file.txt",
      toolInput: {
        file_path: "/tmp/new-file.txt",
        new_content: "hello world",
      },
    });
  });
});
