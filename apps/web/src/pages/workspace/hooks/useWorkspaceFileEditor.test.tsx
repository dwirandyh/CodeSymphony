import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SaveAutomationConfig } from "@codesymphony/shared-types";
import { api } from "../../../lib/api";
import { useWorkspaceFileEditor } from "./useWorkspaceFileEditor";

vi.mock("../../../lib/api", () => ({
  api: {
    getFileContents: vi.fn().mockResolvedValue({ oldContent: null, newContent: null }),
    getWorktreeFileContent: vi.fn(),
    runTerminalCommand: vi.fn(),
    saveWorktreeFileContent: vi.fn(),
  },
}));

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let hookResult: ReturnType<typeof useWorkspaceFileEditor>;
let testActiveFilePath: string;
let testFileEntries: Array<{ path: string; type: "file" }>;
let testSaveAutomation: SaveAutomationConfig | null;
let resolveSaveAutomationTargetSessionId: ReturnType<typeof vi.fn>;
let onError: ReturnType<typeof vi.fn>;

function flushPromises() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function createDeferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: resolvePromise,
  };
}

function TestComponent() {
  hookResult = useWorkspaceFileEditor({
    activeFilePath: testActiveFilePath,
    activeGitBaselineVersionKey: "main:clean:0:0",
    activeView: "file",
    fileEntries: testFileEntries,
    onError,
    resolveSaveAutomationTargetSessionId,
    saveAutomation: testSaveAutomation,
    selectedThreadId: null,
    selectedWorktreeId: "worktree-1",
    selectedWorktreePath: "/repo",
    updateSearch: vi.fn(),
  });

  return null;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  vi.clearAllMocks();
  vi.mocked(api.runTerminalCommand).mockResolvedValue(undefined);
  testActiveFilePath = "src/example.ts";
  testFileEntries = [{ path: "src/example.ts", type: "file" }];
  testSaveAutomation = null;
  resolveSaveAutomationTargetSessionId = vi.fn().mockReturnValue(null);
  onError = vi.fn();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  queryClient.clear();
  container.remove();
});

describe("useWorkspaceFileEditor", () => {
  it("treats a directly opened file as loading until contents arrive", async () => {
    const fileRequest = createDeferred<{
      path: string;
      content: string;
      mimeType: string;
    }>();

    vi.mocked(api.getWorktreeFileContent).mockReturnValue(fileRequest.promise);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TestComponent />
        </QueryClientProvider>,
      );
      await flushPromises();
    });

    expect(hookResult.activeEditorFileState).toMatchObject({
      draftContent: "",
      loaded: false,
      loading: true,
    });
  });

  it("ignores editor draft updates before the file has finished loading", async () => {
    const fileRequest = createDeferred<{
      path: string;
      content: string;
      mimeType: string;
    }>();

    vi.mocked(api.getWorktreeFileContent).mockReturnValue(fileRequest.promise);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TestComponent />
        </QueryClientProvider>,
      );
      await flushPromises();
    });

    act(() => {
      hookResult.handleEditorDraftChange("src/example.ts", "");
    });

    expect(hookResult.activeEditorFileState).toMatchObject({
      draftContent: "",
      loaded: false,
      loading: true,
    });

    await act(async () => {
      fileRequest.resolve({
        path: "src/example.ts",
        content: "export const value = 1;\n",
        mimeType: "text/typescript",
      });
      await flushPromises();
    });

    expect(hookResult.activeEditorFileState).toMatchObject({
      draftContent: "export const value = 1;\n",
      savedContent: "export const value = 1;\n",
      loaded: true,
      loading: false,
      mimeType: "text/typescript",
    });
  });

  it("sends save automation payload after saving a matching file", async () => {
    vi.useFakeTimers();
    testActiveFilePath = "lib/main.dart";
    testFileEntries = [{ path: "lib/main.dart", type: "file" }];
    testSaveAutomation = {
      enabled: true,
      target: "active_run_session",
      filePatterns: ["lib/**/*.dart"],
      actionType: "send_stdin",
      payload: "r",
      debounceMs: 250,
    };
    resolveSaveAutomationTargetSessionId.mockReturnValue("run-session-1");
    vi.mocked(api.getWorktreeFileContent).mockResolvedValue({
      path: "lib/main.dart",
      content: "void main() {}\n",
      mimeType: "text/x-dart",
    });
    vi.mocked(api.saveWorktreeFileContent).mockResolvedValue({
      path: "lib/main.dart",
      content: "void main() { runApp(App()); }\n",
      mimeType: "text/x-dart",
    });

    try {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <TestComponent />
          </QueryClientProvider>,
        );
        await vi.advanceTimersByTimeAsync(0);
      });

      act(() => {
        hookResult.handleEditorDraftChange("lib/main.dart", "void main() { runApp(App()); }\n");
      });

      await act(async () => {
        await hookResult.handleSaveActiveFile();
      });

      expect(api.runTerminalCommand).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });

      expect(resolveSaveAutomationTargetSessionId).toHaveBeenCalledWith("worktree-1");
      expect(api.runTerminalCommand).toHaveBeenCalledWith({
        sessionId: "run-session-1",
        command: "r",
        cwd: "/repo",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
