import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionPromptCard } from "./PermissionPromptCard";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("PermissionPromptCard", () => {
  const defaultProps = {
    requestId: "req-1",
    toolName: "Bash",
    command: "npm install",
    editTarget: null,
    blockedPath: null,
    decisionReason: null,
    busy: false,
    canAlwaysAllow: false,
    onAllowOnce: vi.fn(),
    onAllowAlways: vi.fn(),
    onDeny: vi.fn(),
  };

  it("renders bash permission prompt", () => {
    act(() => {
      root.render(<PermissionPromptCard {...defaultProps} />);
    });
    expect(container.textContent).toContain("Run this command?");
    expect(container.textContent).toContain("npm install");
    expect(container.textContent).toContain("Allow once");
    expect(container.textContent).toContain("Deny");
  });

  it("renders edit permission prompt", () => {
    act(() => {
      root.render(
        <PermissionPromptCard
          {...defaultProps}
          toolName="edit"
          command={null}
          editTarget="src/file.ts"
        />
      );
    });
    expect(container.textContent).toContain("Apply this edit?");
    expect(container.textContent).toContain("src/file.ts");
    expect(container.textContent).toContain("Apply edit");
    expect(container.textContent).toContain("Keep file");
  });

  it("calls onAllowOnce when clicking allow", () => {
    act(() => {
      root.render(<PermissionPromptCard {...defaultProps} />);
    });
    const btn = container.querySelector('[aria-label="Allow once req-1"]') as HTMLButtonElement;
    act(() => btn.click());
    expect(defaultProps.onAllowOnce).toHaveBeenCalledWith("req-1");
  });

  it("calls onDeny when clicking deny", () => {
    act(() => {
      root.render(<PermissionPromptCard {...defaultProps} />);
    });
    const btn = container.querySelector('[aria-label="Deny req-1"]') as HTMLButtonElement;
    act(() => btn.click());
    expect(defaultProps.onDeny).toHaveBeenCalledWith("req-1");
  });

  it("disables buttons when busy", () => {
    act(() => {
      root.render(<PermissionPromptCard {...defaultProps} busy={true} />);
    });
    const buttons = container.querySelectorAll("button");
    buttons.forEach((btn) => {
      expect(btn.disabled).toBe(true);
    });
  });

  it("shows always allow when canAlwaysAllow", () => {
    act(() => {
      root.render(<PermissionPromptCard {...defaultProps} canAlwaysAllow={true} />);
    });
    expect(container.textContent).toContain("More options");
  });

  it("shows decision reason in details", () => {
    act(() => {
      root.render(
        <PermissionPromptCard
          {...defaultProps}
          decisionReason="Requires elevated permissions"
        />
      );
    });
    expect(container.textContent).toContain("Requires elevated permissions");
  });

  it("shows blocked path in details", () => {
    act(() => {
      root.render(
        <PermissionPromptCard {...defaultProps} blockedPath="/etc/passwd" />
      );
    });
    expect(container.textContent).toContain("/etc/passwd");
  });

  it("shows tool name when no command", () => {
    act(() => {
      root.render(
        <PermissionPromptCard {...defaultProps} toolName="CustomTool" command={null} />
      );
    });
    expect(container.textContent).toContain("Tool: CustomTool");
  });

  it("shows 'Current file' for edit without target", () => {
    act(() => {
      root.render(
        <PermissionPromptCard {...defaultProps} toolName="write" editTarget={null} />
      );
    });
    expect(container.textContent).toContain("Current file");
  });
});
