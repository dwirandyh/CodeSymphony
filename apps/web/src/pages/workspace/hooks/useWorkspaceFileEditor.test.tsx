import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../lib/api";
import { useWorkspaceFileEditor } from "./useWorkspaceFileEditor";

vi.mock("../../../lib/api", () => ({
  api: {
    getFileContents: vi.fn().mockResolvedValue({ oldContent: null, newContent: null }),
    getWorktreeFileContent: vi.fn(),
    saveWorktreeFileContent: vi.fn(),
  },
}));

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let hookResult: ReturnType<typeof useWorkspaceFileEditor>;

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
    activeFilePath: "src/example.ts",
    activeGitBaselineVersionKey: "main:clean:0:0",
    activeView: "file",
    fileEntries: [{ path: "src/example.ts", type: "file" }],
    onError: vi.fn(),
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
});
