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
    alwaysAllowScope: null,
    alwaysAllowDescription: null,
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

  it("shows split allow chevron when canAlwaysAllow", () => {
    act(() => {
      root.render(
        <PermissionPromptCard
          {...defaultProps}
          canAlwaysAllow={true}
          alwaysAllowScope="session"
          alwaysAllowDescription="Remembers this approval for the current Codex session only."
        />
      );
    });
    expect(container.textContent).toContain("Allow once");
    expect(container.querySelector('[aria-label="Show always allow options req-1"]')).toBeTruthy();
    expect(container.textContent).not.toContain("Always allow");
    expect(container.textContent).not.toContain("More options");
  });

  it("reveals always allow from the split chevron", () => {
    const onAllowAlways = vi.fn();
    act(() => {
      root.render(
        <PermissionPromptCard
          {...defaultProps}
          canAlwaysAllow={true}
          alwaysAllowScope="session"
          alwaysAllowDescription="Remembers this approval for the current Codex session only."
          onAllowAlways={onAllowAlways}
        />
      );
    });

    const chevron = container.querySelector('[aria-label="Show always allow options req-1"]') as HTMLButtonElement;
    act(() => chevron.click());

    expect(container.querySelector('[role="menu"]')).toBeTruthy();
    expect(container.textContent).toContain("Always allow");
    expect(container.textContent).toContain("Remembers this approval for the current Codex session only.");
    expect(container.textContent).not.toContain(".claude/settings.local.json");
    expect(container.textContent).not.toContain("Always allow in this workspace");

    const alwaysButton = container.querySelector('[aria-label="Always allow req-1"]') as HTMLButtonElement;
    act(() => alwaysButton.click());
    expect(onAllowAlways).toHaveBeenCalledWith("req-1");
    expect(container.textContent).not.toContain("Always allow");
  });

  it("renders workspace always allow scope copy", () => {
    act(() => {
      root.render(
        <PermissionPromptCard
          {...defaultProps}
          canAlwaysAllow={true}
          alwaysAllowScope="workspace"
          alwaysAllowDescription="Persists this approval in the workspace for matching future requests."
        />
      );
    });
    const chevron = container.querySelector('[aria-label="Show always allow options req-1"]') as HTMLButtonElement;
    act(() => chevron.click());
    expect(container.textContent).toContain("Persists this approval in the workspace for matching future requests.");
  });

  it("renders native always allow scope copy", () => {
    act(() => {
      root.render(
        <PermissionPromptCard
          {...defaultProps}
          canAlwaysAllow={true}
          alwaysAllowScope="native"
          alwaysAllowDescription="Uses Cursor's native always-allow option for matching future requests."
        />
      );
    });
    const chevron = container.querySelector('[aria-label="Show always allow options req-1"]') as HTMLButtonElement;
    act(() => chevron.click());
    expect(container.textContent).toContain("Uses Cursor's native always-allow option for matching future requests.");
  });

  it("hides always allow when canAlwaysAllow is false", () => {
    act(() => {
      root.render(<PermissionPromptCard {...defaultProps} canAlwaysAllow={false} />);
    });
    expect(container.textContent).not.toContain("More options");
    expect(container.textContent).not.toContain("Always allow");
    expect(container.querySelector('[aria-label="Show always allow options req-1"]')).toBeNull();
  });

  it("closes always allow panel when busy", () => {
    act(() => {
      root.render(
        <PermissionPromptCard
          {...defaultProps}
          canAlwaysAllow={true}
          alwaysAllowScope="session"
          alwaysAllowDescription="Remembers this approval for the current Codex session only."
        />
      );
    });
    const chevron = container.querySelector('[aria-label="Show always allow options req-1"]') as HTMLButtonElement;
    act(() => chevron.click());
    expect(container.textContent).toContain("Always allow");

    act(() => {
      root.render(
        <PermissionPromptCard
          {...defaultProps}
          busy={true}
          canAlwaysAllow={true}
          alwaysAllowScope="session"
          alwaysAllowDescription="Remembers this approval for the current Codex session only."
        />
      );
    });

    expect(container.textContent).not.toContain("Always allow");
    const buttons = container.querySelectorAll("button");
    buttons.forEach((button) => expect(button.disabled).toBe(true));
  });

  it("does not render more options or decision metadata", () => {
    act(() => {
      root.render(
        <PermissionPromptCard
          {...defaultProps}
          decisionReason="Requires elevated permissions"
        />
      );
    });
    expect(container.textContent).not.toContain("More options");
    expect(container.textContent).not.toContain("Requires elevated permissions");
  });

  it("does not render blocked path metadata", () => {
    act(() => {
      root.render(
        <PermissionPromptCard {...defaultProps} blockedPath="/etc/passwd" />
      );
    });
    expect(container.textContent).not.toContain("More options");
    expect(container.textContent).not.toContain("/etc/passwd");
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
