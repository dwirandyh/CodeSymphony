import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { IssueReportDialog } from "./IssueReportDialog";

vi.mock("../../lib/api", () => ({
  api: {
    createIssueReport: vi.fn(),
    openPath: vi.fn(),
  },
}));

let container: HTMLDivElement;
let root: Root;

function act(callback: () => void): void;
function act(callback: () => Promise<void>): Promise<void>;
function act(callback: () => void | Promise<void>): void | Promise<void> {
  let result: unknown;
  flushSync(() => {
    result = callback();
  });

  if (result && typeof result === "object" && "then" in result && typeof result.then === "function") {
    return result.then(() => Promise.resolve());
  }

  return undefined;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(api.createIssueReport).mockResolvedValue({
    id: "report-1",
    directoryPath: "/tmp/codesymphony/report-1",
    issuePath: "/tmp/codesymphony/report-1/issue.md",
    diagnosticsPath: "/tmp/codesymphony/report-1/diagnostics.json",
    debugLogPath: "/tmp/codesymphony/report-1/debug-log.ndjson",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  vi.mocked(api.openPath).mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function renderDialog() {
  act(() => {
    root.render(
      <IssueReportDialog
        open
        onClose={() => {}}
        repositoryId="repo-1"
        worktreeId="worktree-1"
        threadId="thread-1"
      />,
    );
  });
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));
}

async function waitForText(text: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (document.body.textContent?.includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("IssueReportDialog", () => {
  it("requires a description before creating a report", () => {
    renderDialog();

    const button = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
      .find((candidate) => candidate.textContent?.includes("Create Report"));

    expect(button?.disabled).toBe(true);
  });

  it("creates an issue report with the current workspace context", async () => {
    renderDialog();

    const textarea = document.body.querySelector("textarea");
    if (!textarea) {
      throw new Error("textarea not found");
    }

    await act(async () => {
      setTextareaValue(textarea, "Chat stream froze");
    });

    const button = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
      .find((candidate) => candidate.textContent?.includes("Create Report"));
    if (!button) {
      throw new Error("create report button not found");
    }

    await act(async () => {
      button.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitForText("Issue report created");

    expect(api.createIssueReport).toHaveBeenCalledWith({
      description: "Chat stream froze",
      repositoryId: "repo-1",
      worktreeId: "worktree-1",
      threadId: "thread-1",
    });
    expect(document.body.textContent).toContain("Issue report created");
    expect(document.body.textContent).toContain("/tmp/codesymphony/report-1");
  });

  it("opens the report folder from the success state", async () => {
    renderDialog();

    const textarea = document.body.querySelector("textarea");
    if (!textarea) {
      throw new Error("textarea not found");
    }

    await act(async () => {
      setTextareaValue(textarea, "Problem");
    });

    const createButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
      .find((candidate) => candidate.textContent?.includes("Create Report"));
    if (!createButton) {
      throw new Error("create report button not found");
    }

    await act(async () => {
      createButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitForText("Open Folder");

    const openButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
      .find((candidate) => candidate.textContent?.includes("Open Folder"));
    if (!openButton) {
      throw new Error("open folder button not found");
    }

    await act(async () => {
      openButton.click();
      await Promise.resolve();
    });

    expect(api.openPath).toHaveBeenCalledWith({ targetPath: "/tmp/codesymphony/report-1" });
  });
});
