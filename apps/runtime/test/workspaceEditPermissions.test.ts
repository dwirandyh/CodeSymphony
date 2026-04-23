import { describe, expect, it } from "vitest";
import { __testing, shouldAutoApproveWorkspaceEdit } from "../src/services/chat/workspaceEditPermissions.js";

describe("workspace edit permission policy", () => {
  it("accepts edit targets that stay inside the workspace root", () => {
    expect(shouldAutoApproveWorkspaceEdit({
      workspaceRoot: "/tmp/worktree",
      toolName: "Edit",
      toolInput: {
        file_path: "/tmp/worktree/src/main.ts",
      },
      blockedPath: "/tmp/worktree/src/main.ts",
    })).toBe(true);

    expect(shouldAutoApproveWorkspaceEdit({
      workspaceRoot: "/tmp/worktree",
      toolName: "Write",
      toolInput: {
        file_path: "src/new-file.ts",
      },
    })).toBe(true);
  });

  it("rejects edit targets that escape the workspace root", () => {
    expect(shouldAutoApproveWorkspaceEdit({
      workspaceRoot: "/tmp/worktree",
      toolName: "Edit",
      toolInput: {
        file_path: "/tmp/other/outside.ts",
      },
      blockedPath: "/tmp/other/outside.ts",
    })).toBe(false);

    expect(shouldAutoApproveWorkspaceEdit({
      workspaceRoot: "/tmp/worktree",
      toolName: "Write",
      toolInput: {
        file_path: "../outside.ts",
      },
    })).toBe(false);
  });

  it("accepts generic permission requests only when all write targets stay inside the workspace root", () => {
    expect(shouldAutoApproveWorkspaceEdit({
      workspaceRoot: "/tmp/worktree",
      toolName: "Permissions",
      toolInput: {
        permissions: {
          fileSystem: {
            write: ["/tmp/worktree/src/main.ts", "docs/guide.md"],
          },
        },
      },
    })).toBe(true);

    expect(shouldAutoApproveWorkspaceEdit({
      workspaceRoot: "/tmp/worktree",
      toolName: "Permissions",
      toolInput: {
        permissions: {
          fileSystem: {
            write: ["/tmp/worktree/src/main.ts", "/tmp/outside.ts"],
          },
        },
      },
    })).toBe(false);
  });

  it("extracts only explicit write targets from generic permission payloads", () => {
    expect(__testing.extractPermissionWriteTargets({
      permissions: {
        fileSystem: {
          write: ["a.ts", "b.ts"],
          read: ["README.md"],
        },
      },
    })).toEqual(["a.ts", "b.ts"]);
  });
});
