import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Repository } from "@codesymphony/shared-types";
import { queryKeys } from "../../lib/queryKeys";
import { api } from "../../lib/api";
import { SettingsDialog } from "./SettingsDialog";

vi.mock("../../lib/api", () => ({
  api: {
    listBranches: vi.fn(),
    updateRepositoryScripts: vi.fn(),
  },
}));

const baseRepository: Repository = {
  id: "repo-1",
  name: "example-repo",
  rootPath: "/tmp/example-repo",
  defaultBranch: "main",
  setupScript: null,
  teardownScript: null,
  runScript: null,
  createdAt: "2026-02-20T00:00:00.000Z",
  updatedAt: "2026-02-20T00:00:00.000Z",
  worktrees: [],
};

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  nativeSetter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("SettingsDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = createQueryClient();

    vi.mocked(api.listBranches).mockResolvedValue(["main"]);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  function renderDialog(onClose: () => void = () => {}) {
    queryClient.setQueryData(queryKeys.repositories.all, [baseRepository]);
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SettingsDialog
            open
            onClose={onClose}
            repositories={[baseRepository]}
            onRemoveRepository={() => {}}
          />
        </QueryClientProvider>,
      );
    });
  }

  it("updates repositories query cache with saved scripts", async () => {
    const updatedRepository: Repository = {
      ...baseRepository,
      runScript: ["npm run dev", "pnpm build"],
      updatedAt: "2026-02-23T00:00:00.000Z",
    };
    vi.mocked(api.updateRepositoryScripts).mockResolvedValue(updatedRepository);

    renderDialog();
    await flushEffects();

    const runScriptTextarea = container.querySelectorAll("textarea")[0];
    expect(runScriptTextarea).toBeDefined();

    await act(async () => {
      if (runScriptTextarea) {
        setTextareaValue(runScriptTextarea, " npm run dev \n\n pnpm build ");
      }
    });
    await flushEffects();

    await act(async () => {
      vi.advanceTimersByTime(1_100);
      await Promise.resolve();
    });
    await flushEffects();

    expect(api.updateRepositoryScripts).toHaveBeenCalledWith("repo-1", {
      runScript: ["npm run dev", "pnpm build"],
      setupScript: null,
      teardownScript: null,
    });

    const cachedRepositories = queryClient.getQueryData<Repository[]>(queryKeys.repositories.all);
    expect(cachedRepositories?.[0]?.runScript).toEqual(["npm run dev", "pnpm build"]);
  });

  it("flushes pending save before closing settings", async () => {
    const onClose = vi.fn();
    const updatedRepository: Repository = {
      ...baseRepository,
      runScript: ["npm run dev"],
      updatedAt: "2026-02-23T00:00:00.000Z",
    };
    vi.mocked(api.updateRepositoryScripts).mockResolvedValue(updatedRepository);

    renderDialog(onClose);
    await flushEffects();

    const runScriptTextarea = container.querySelectorAll("textarea")[0];
    expect(runScriptTextarea).toBeDefined();

    await act(async () => {
      if (runScriptTextarea) {
        setTextareaValue(runScriptTextarea, "npm run dev");
      }
    });
    await flushEffects();

    const backButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Settings"),
    );
    expect(backButton).toBeDefined();

    await act(async () => {
      backButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    await flushEffects();

    await act(async () => {
      vi.advanceTimersByTime(1_100);
      await Promise.resolve();
    });
    await flushEffects();

    expect(api.updateRepositoryScripts).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
