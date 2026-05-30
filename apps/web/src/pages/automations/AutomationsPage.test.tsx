import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Automation, AutomationPromptVersion, AutomationRun, Repository } from "@codesymphony/shared-types";
import { queryKeys } from "../../lib/queryKeys";
import { AutomationDetailPage, AutomationsListPage, WorkspaceAutomationsPanel } from "./AutomationsPage";

const navigateMock = vi.hoisted(() => vi.fn());
const apiMocks = vi.hoisted(() => ({
  listAutomations: vi.fn(),
  listClaudeModels: vi.fn().mockResolvedValue({ models: [], fetchedAt: "2026-01-01T00:00:00.000Z" }),
  listCodexModels: vi.fn().mockResolvedValue({ models: [], fetchedAt: "2026-01-01T00:00:00.000Z" }),
  listCursorModels: vi.fn().mockResolvedValue({ models: [], fetchedAt: "2026-01-01T00:00:00.000Z" }),
  listOpencodeModels: vi.fn().mockResolvedValue({ models: [], fetchedAt: "2026-01-01T00:00:00.000Z" }),
  createAutomation: vi.fn(),
  getAutomation: vi.fn(),
  getFileIndex: vi.fn(),
  getSlashCommands: vi.fn(),
  listAutomationRuns: vi.fn(),
  listAutomationPromptVersions: vi.fn(),
  restoreAutomationPromptVersion: vi.fn(),
  updateAutomation: vi.fn(),
  runAutomationNow: vi.fn(),
  deleteAutomation: vi.fn(),
}));

const useRepositoriesMock = vi.hoisted(() => ({
  useRepositories: vi.fn(),
}));

const useModelProvidersMock = vi.hoisted(() => ({
  useModelProviders: vi.fn(),
}));

const automationRunsHooksMock = vi.hoisted(() => ({
  useAutomationRuns: vi.fn(),
  requestAutomationRunsLiveRefresh: vi.fn(),
}));

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
  return {
    ...actual,
    Link: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a>,
    useNavigate: () => navigateMock,
  };
});

vi.mock("../../lib/api", () => ({
  api: {
    listAutomations: apiMocks.listAutomations,
    listClaudeModels: apiMocks.listClaudeModels,
    listCodexModels: apiMocks.listCodexModels,
    listCursorModels: apiMocks.listCursorModels,
    listOpencodeModels: apiMocks.listOpencodeModels,
    createAutomation: apiMocks.createAutomation,
    getAutomation: apiMocks.getAutomation,
    getFileIndex: apiMocks.getFileIndex,
    getSlashCommands: apiMocks.getSlashCommands,
    listAutomationRuns: apiMocks.listAutomationRuns,
    listAutomationPromptVersions: apiMocks.listAutomationPromptVersions,
    restoreAutomationPromptVersion: apiMocks.restoreAutomationPromptVersion,
    updateAutomation: apiMocks.updateAutomation,
    runAutomationNow: apiMocks.runAutomationNow,
    deleteAutomation: apiMocks.deleteAutomation,
  },
}));

vi.mock("../../hooks/queries/useRepositories", () => ({
  useRepositories: useRepositoriesMock.useRepositories,
}));

vi.mock("../workspace/hooks/useModelProviders", () => ({
  useModelProviders: useModelProvidersMock.useModelProviders,
}));

vi.mock("../workspace/hooks/useWorkspaceSyncStream", () => ({
  useWorkspaceSyncStream: () => undefined,
}));

vi.mock("../../hooks/queries/useAutomationRuns", () => ({
  useAutomationRuns: automationRunsHooksMock.useAutomationRuns,
  requestAutomationRunsLiveRefresh: automationRunsHooksMock.requestAutomationRunsLiveRefresh,
}));

vi.mock("../../components/ui/dialog", () => ({
  Dialog: ({
    open,
    children,
  }: {
    open?: boolean;
    children: React.ReactNode;
  }) => open ? <div>{children}</div> : null,
  DialogContent: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  DialogDescription: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  DialogHeader: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  DialogTitle: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
}));

vi.mock("../../components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({
    children,
    align: _align,
    side: _side,
    sideOffset: _sideOffset,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & {
    align?: string;
    side?: string;
    sideOffset?: number;
  }) => <div {...props}>{children}</div>,
}));

vi.mock("./AutomationPromptEditor", () => ({
  AutomationPromptEditor: ({
    value,
    onChange,
    placeholder,
    className,
    disabled,
    testId,
  }: {
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    className?: string;
    disabled?: boolean;
    testId?: string;
  }) => (
    <textarea
      data-testid={testId}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      className={className}
      disabled={disabled}
    />
  ),
}));

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

function makeRepository(overrides: Partial<Repository> = {}): Repository {
  return {
    id: "repo-1",
    name: "codesymphony",
    rootPath: "/tmp/codesymphony",
    defaultBranch: "main",
    setupScript: null,
    teardownScript: null,
    runScript: null,
    saveAutomation: null,
    createdAt: "2026-05-10T10:00:00.000Z",
    updatedAt: "2026-05-10T10:00:00.000Z",
    worktrees: [
      {
        id: "wt-1",
        repositoryId: "repo-1",
        branch: "main",
        path: "/tmp/codesymphony",
        status: "active",
        baseBranch: "main",
        branchRenamed: false,
        lastCreateError: null,
        lastDeleteError: null,
        createdAt: "2026-05-10T10:00:00.000Z",
        updatedAt: "2026-05-10T10:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: "automation-1",
    repositoryId: "repo-1",
    targetWorktreeId: "wt-1",
    targetMode: "repo_root",
    name: "Nightly audit",
    prompt: "Audit the repository and summarize the next actions.",
    enabled: true,
    agent: "codex",
    model: "gpt-5.4",
    modelProviderId: null,
    permissionMode: "full_access",
    chatMode: "default",
    rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
    timezone: "Asia/Jakarta",
    dtstart: "2026-05-10T02:00:00.000Z",
    nextRunAt: "2026-05-11T02:00:00.000Z",
    lastRunAt: null,
    latestRun: null,
    createdAt: "2026-05-10T10:00:00.000Z",
    updatedAt: "2026-05-10T10:00:00.000Z",
    ...overrides,
  };
}

function makeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: "run-1",
    automationId: "automation-1",
    repositoryId: "repo-1",
    worktreeId: "wt-1",
    threadId: "thread-1",
    status: "succeeded",
    triggerKind: "manual",
    scheduledFor: "2026-05-10T02:00:00.000Z",
    startedAt: "2026-05-10T02:00:10.000Z",
    finishedAt: "2026-05-10T02:00:20.000Z",
    error: null,
    summary: "Summarized yesterday's changes.",
    createdAt: "2026-05-10T02:00:00.000Z",
    updatedAt: "2026-05-10T02:00:20.000Z",
    ...overrides,
  };
}

function makeVersion(overrides: Partial<AutomationPromptVersion> = {}): AutomationPromptVersion {
  return {
    id: "version-1",
    automationId: "automation-1",
    content: "Previous prompt draft",
    source: "manual",
    restoredFromVersionId: null,
    createdAt: "2026-05-10T02:00:00.000Z",
    updatedAt: "2026-05-10T02:00:00.000Z",
    ...overrides,
  };
}

async function flushEffects() {
  await act(async () => {
    if (vi.isFakeTimers()) {
      await vi.advanceTimersByTimeAsync(0);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(
    input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
    "value",
  );
  const valueSetter = descriptor?.set;
  if (!valueSetter) {
    throw new Error("Input value setter not available");
  }

  await act(async () => {
    valueSetter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function getEditorText(editor: HTMLElement): string {
  return editor instanceof HTMLTextAreaElement ? editor.value : (editor.textContent ?? "");
}

async function setEditorValue(editor: HTMLElement, value: string) {
  if (editor instanceof HTMLTextAreaElement) {
    await setInputValue(editor, value);
    return;
  }

  await act(async () => {
    editor.textContent = value;
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function findButton(label: string): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll("button")).find(
    (entry) => entry.textContent?.trim() === label,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}

function findButtonByAriaLabel(label: string): HTMLButtonElement {
  const button = document.body.querySelector(`button[aria-label="${label}"]`);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}

function findInputByPlaceholder(placeholder: string): HTMLInputElement {
  const input = Array.from(document.body.querySelectorAll("input")).find(
    (entry) => entry.getAttribute("placeholder") === placeholder,
  );
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Input not found: ${placeholder}`);
  }
  return input;
}

function findSelectOption(label: string): HTMLElement {
  const option = Array.from(document.body.querySelectorAll('[role="option"]')).find(
    (entry) => entry.textContent?.trim() === label,
  );
  if (!(option instanceof HTMLElement)) {
    throw new Error(`Select option not found: ${label}`);
  }
  return option;
}

async function chooseSelectOption(ariaLabel: string, optionLabel: string) {
  const PointerEventCtor = globalThis.PointerEvent ?? MouseEvent;
  const trigger = findButtonByAriaLabel(ariaLabel);
  await act(async () => {
    trigger.dispatchEvent(new PointerEventCtor("pointerdown", {
      bubbles: true,
      button: 0,
      ctrlKey: false,
      pointerId: 1,
    }));
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushEffects();

  if (!document.body.querySelector('[role="option"]')) {
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await flushEffects();
  }

  await act(async () => {
    findSelectOption(optionLabel).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushEffects();
}

beforeEach(() => {
  if (!HTMLElement.prototype.hasPointerCapture) {
    Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
      configurable: true,
      value: () => false,
    });
  }
  if (!HTMLElement.prototype.setPointerCapture) {
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: () => undefined,
    });
  }
  if (!HTMLElement.prototype.releasePointerCapture) {
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
      configurable: true,
      value: () => undefined,
    });
  }
  if (!HTMLElement.prototype.scrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: () => undefined,
    });
  }

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

  useRepositoriesMock.useRepositories.mockReturnValue({
    data: [makeRepository()],
    isLoading: false,
  });
  useModelProvidersMock.useModelProviders.mockReturnValue({ providers: [] });
  apiMocks.listAutomations.mockResolvedValue([]);
  apiMocks.createAutomation.mockResolvedValue(makeAutomation());
  apiMocks.getAutomation.mockResolvedValue(makeAutomation({ latestRun: makeRun() }));
  apiMocks.getFileIndex.mockResolvedValue([]);
  apiMocks.getSlashCommands.mockResolvedValue({
    commands: [],
    updatedAt: "2026-05-10T10:00:00.000Z",
  });
  apiMocks.listAutomationRuns.mockResolvedValue([makeRun()]);
  automationRunsHooksMock.useAutomationRuns.mockReturnValue({
    data: [makeRun()],
    isLoading: false,
    isFetching: false,
    connectionState: "healthy",
    error: null,
    refetch: vi.fn(),
  });
  automationRunsHooksMock.requestAutomationRunsLiveRefresh.mockReset();
  apiMocks.listAutomationPromptVersions.mockResolvedValue([makeVersion()]);
  apiMocks.restoreAutomationPromptVersion.mockResolvedValue(makeAutomation());
  apiMocks.updateAutomation.mockResolvedValue(makeAutomation());
  apiMocks.runAutomationNow.mockResolvedValue(makeRun());
  apiMocks.deleteAutomation.mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
  vi.clearAllMocks();
});

describe("AutomationsListPage", () => {
  it("uses status wording without showing a redundant current section or count summary", async () => {
    apiMocks.listAutomations.mockResolvedValue([makeAutomation()]);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AutomationsListPage layout="panel" />
        </QueryClientProvider>,
      );
    });

    await flushEffects();
    await flushEffects();

    expect(document.body.textContent).toContain("Status");
    expect(document.body.textContent).toContain("Active");
    expect(document.body.textContent).not.toContain("Current");
    expect(document.body.textContent).not.toContain("1 automation");
    expect(document.body.textContent?.match(/Automations/g)?.length).toBe(1);
    expect(document.body.textContent).not.toContain("Refresh");
  });

  it("renders automation rows as simplified single-line items", async () => {
    apiMocks.listAutomations.mockResolvedValue([
      makeAutomation({
        nextRunAt: undefined,
      }),
    ]);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AutomationsListPage layout="panel" />
        </QueryClientProvider>,
      );
    });

    await flushEffects();
    await flushEffects();

    expect(document.body.textContent).toContain("Nightly audit");
    expect(document.body.textContent).toContain("codesymphony");
    expect(document.body.textContent).toContain("Daily at 9:00 AM");
    expect(document.body.textContent).not.toContain("Audit the repository and summarize the next actions.");
    expect(document.body.textContent).not.toContain("Never");
    expect(document.body.querySelector('button[aria-label="Pause Nightly audit"]')).toBeNull();

    const promptParagraph = Array.from(document.body.querySelectorAll("p")).find(
      (entry) => entry.textContent?.includes("Audit the repository and summarize the next actions."),
    );

    expect(promptParagraph).toBeFalsy();
  });

  it("reveals row actions through a more menu and keeps them from triggering row open", async () => {
    const onOpenAutomation = vi.fn();
    apiMocks.listAutomations
      .mockResolvedValueOnce([makeAutomation()])
      .mockResolvedValueOnce([]);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AutomationsListPage layout="panel" onOpenAutomation={onOpenAutomation} />
        </QueryClientProvider>,
      );
    });

    await flushEffects();
    await flushEffects();

    await act(async () => {
      findButtonByAriaLabel("More actions for Nightly audit").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.body.textContent).toContain("Pause");
    expect(document.body.textContent).toContain("Delete");

    await act(async () => {
      findButtonByAriaLabel("Edit Nightly audit").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onOpenAutomation).toHaveBeenCalledWith("automation-1");

    await act(async () => {
      findButtonByAriaLabel("More actions for Nightly audit").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => {
      findButton("Delete").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await flushEffects();

    expect(apiMocks.deleteAutomation).toHaveBeenCalled();
    expect(apiMocks.deleteAutomation.mock.calls[0]?.[0]).toBe("automation-1");
    expect(apiMocks.listAutomations).toHaveBeenCalledTimes(2);
  });

  it("does not prefilter the automations list to the active workspace repository", async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AutomationsListPage
            layout="panel"
            prefills={{
              repositoryId: "repo-1",
              worktreeId: "wt-1",
            }}
          />
        </QueryClientProvider>,
      );
    });

    await flushEffects();

    expect(apiMocks.listAutomations).toHaveBeenCalledWith({
      repositoryId: undefined,
      enabled: true,
    });
  });

  it("renders a simplified create composer with inline project and schedule controls", async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AutomationsListPage prefills={{ create: true }} />
        </QueryClientProvider>,
      );
    });

    await flushEffects();

    expect(document.body.textContent).toContain("Create automation");
    expect(document.body.textContent).not.toContain("Every run starts in a fresh workspace thread");
    expect(document.body.textContent).not.toContain("Keep the flow simple");
    expect(document.body.textContent).not.toContain("Cancel");
    expect(document.body.textContent).not.toContain("Agent settings");
    expect(document.body.textContent).not.toContain("Plan");

    expect(findButtonByAriaLabel("Select project").textContent).toContain("codesymphony");
    expect(findButtonByAriaLabel("Select root or worktree").textContent).toContain("Root");
    expect(findButtonByAriaLabel("Select schedule").textContent).toContain("Daily at 9:00 AM");
    expect(findButtonByAriaLabel("Select automation session").textContent).toContain("Claude");

    const titleInput = Array.from(document.body.querySelectorAll("input")).find((entry) => entry.getAttribute("placeholder") === "Automation title");
    const promptField = document.body.querySelector('[data-testid="automation-create-prompt-editor"]');

    expect(titleInput).toBeTruthy();
    expect(promptField).toBeTruthy();
  });

  it("uses workspace-header-style pickers for create automation targets", async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AutomationsListPage prefills={{ create: true }} />
        </QueryClientProvider>,
      );
    });

    await flushEffects();

    const triggerButtons = [
      findButtonByAriaLabel("Select project"),
      findButtonByAriaLabel("Select root or worktree"),
      findButtonByAriaLabel("Select schedule"),
      findButtonByAriaLabel("Select automation session"),
    ];

    for (const trigger of triggerButtons) {
      expect(trigger.className).toContain("text-[12px]");
      expect(trigger.className).toContain("hover:bg-secondary/35");
      expect(trigger.className).toContain("rounded-md");
    }
  });

  it("keeps the create action disabled while the form is invalid", async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AutomationsListPage prefills={{ create: true }} />
        </QueryClientProvider>,
      );
    });

    await flushEffects();

    expect(findButton("Create").disabled).toBe(true);

    expect(apiMocks.createAutomation).not.toHaveBeenCalled();
  });

  it("disables the create action until the required fields are filled", async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AutomationsListPage prefills={{ create: true }} />
        </QueryClientProvider>,
      );
    });

    await flushEffects();

    const createButton = findButton("Create");
    const titleInput = findInputByPlaceholder("Automation title");
    const promptField = document.body.querySelector('[data-testid="automation-create-prompt-editor"]');

    if (!(promptField instanceof HTMLElement)) {
      throw new Error("Expected prompt editor");
    }

    expect(createButton.disabled).toBe(true);

    await setInputValue(titleInput, "Automation smoke");
    await setEditorValue(promptField, "Watch for failures and summarize them.");
    await flushEffects();

    expect(findButton("Create").disabled).toBe(false);
  });

  it("uses the repository root worktree when creating a root automation from a feature-worktree context", async () => {
    useRepositoriesMock.useRepositories.mockReturnValue({
      data: [
        makeRepository({
          worktrees: [
            {
              id: "wt-1",
              repositoryId: "repo-1",
              branch: "main",
              path: "/tmp/codesymphony",
              status: "active",
              baseBranch: "main",
              branchRenamed: false,
              lastCreateError: null,
              lastDeleteError: null,
              createdAt: "2026-05-10T10:00:00.000Z",
              updatedAt: "2026-05-10T10:00:00.000Z",
            },
            {
              id: "wt-2",
              repositoryId: "repo-1",
              branch: "feature/live-updates",
              path: "/tmp/codesymphony-feature",
              status: "active",
              baseBranch: "main",
              branchRenamed: false,
              lastCreateError: null,
              lastDeleteError: null,
              createdAt: "2026-05-10T10:00:00.000Z",
              updatedAt: "2026-05-10T10:00:00.000Z",
            },
          ],
        }),
      ],
      isLoading: false,
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AutomationsListPage
            prefills={{ create: true, repositoryId: "repo-1", worktreeId: "wt-2", agent: "codex", model: "gpt-5.4" }}
            layout="panel"
          />
        </QueryClientProvider>,
      );
    });

    await flushEffects();

    const textboxes = Array.from(document.body.querySelectorAll("input"));
    const prompt = document.body.querySelector('[data-testid="automation-create-prompt-editor"]');
    if (!(textboxes[0] instanceof HTMLInputElement) || !(prompt instanceof HTMLElement)) {
      throw new Error("Create form inputs not found");
    }

    await setInputValue(textboxes[0], "Root automation");
    await setEditorValue(prompt, "Summarize root repo changes.");

    await act(async () => {
      findButton("Create").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await flushEffects();

    expect(apiMocks.createAutomation).toHaveBeenCalledOnce();
    expect(apiMocks.createAutomation.mock.calls[0]?.[0]).toMatchObject({
      repositoryId: "repo-1",
      targetMode: "repo_root",
      targetWorktreeId: "wt-1",
    });
  });

  it("clears transient list search params when create succeeds and opens the detail route", async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AutomationsListPage prefills={{ create: true, agent: "codex", model: "gpt-5.4" }} />
        </QueryClientProvider>,
      );
    });

    await flushEffects();

    const textboxes = Array.from(document.body.querySelectorAll("input"));
    const prompt = document.body.querySelector('[data-testid="automation-create-prompt-editor"]');
    if (!(textboxes[0] instanceof HTMLInputElement) || !(prompt instanceof HTMLElement)) {
      throw new Error("Create form inputs not found");
    }

    await setInputValue(textboxes[0], "Automation smoke");
    await setEditorValue(prompt, "Audit the repository and summarize the next actions.");

    await act(async () => {
      findButton("Create").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await flushEffects();

    expect(apiMocks.createAutomation).toHaveBeenCalledOnce();
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/automations/$automationId",
      params: { automationId: "automation-1" },
      search: {},
    });
  });

  it("opens the created automation inside the workspace panel when a panel callback is provided", async () => {
    const onOpenAutomation = vi.fn();

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AutomationsListPage
            prefills={{ create: true, agent: "codex", model: "gpt-5.4" }}
            layout="panel"
            onOpenAutomation={onOpenAutomation}
          />
        </QueryClientProvider>,
      );
    });

    await flushEffects();

    const textboxes = Array.from(document.body.querySelectorAll("input"));
    const prompt = document.body.querySelector('[data-testid="automation-create-prompt-editor"]');
    if (!(textboxes[0] instanceof HTMLInputElement) || !(prompt instanceof HTMLElement)) {
      throw new Error("Create form inputs not found");
    }

    await setInputValue(textboxes[0], "Automation smoke");
    await setEditorValue(prompt, "Audit the repository and summarize the next actions.");

    await act(async () => {
      findButton("Create").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await flushEffects();

    expect(apiMocks.createAutomation).toHaveBeenCalledOnce();
    expect(onOpenAutomation).toHaveBeenCalledWith("automation-1");
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("shows active run status in the row and disables duplicate Run now actions", async () => {
    apiMocks.listAutomations.mockResolvedValue([
      makeAutomation({
        latestRun: makeRun({
          status: "running",
          scheduledFor: "2026-05-10T02:00:00.000Z",
          startedAt: "2026-05-10T02:00:10.000Z",
          finishedAt: null,
        }),
      }),
    ]);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AutomationsListPage layout="panel" />
        </QueryClientProvider>,
      );
    });

    await flushEffects();
    await flushEffects();

    expect(document.body.textContent).toContain("Running");
    expect(findButtonByAriaLabel("Run now Nightly audit").disabled).toBe(true);
  });

  it("disables Run now in the list when a root automation has no active root worktree", async () => {
    useRepositoriesMock.useRepositories.mockReturnValue({
      data: [makeRepository({
        worktrees: [
          {
            id: "wt-feature",
            repositoryId: "repo-1",
            branch: "feat/runtime-live",
            path: "/tmp/codesymphony-worktrees/feat-runtime-live",
            status: "active",
            baseBranch: "main",
            branchRenamed: false,
            lastCreateError: null,
            lastDeleteError: null,
            createdAt: "2026-05-10T10:00:00.000Z",
            updatedAt: "2026-05-10T10:00:00.000Z",
          },
        ],
      })],
      isLoading: false,
    });
    apiMocks.listAutomations.mockResolvedValue([
      makeAutomation({
        latestRun: null,
        targetMode: "repo_root",
        targetWorktreeId: "wt-feature",
      }),
    ]);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AutomationsListPage layout="panel" />
        </QueryClientProvider>,
      );
    });

    await flushEffects();
    await flushEffects();

    expect(findButtonByAriaLabel("Run now Nightly audit").disabled).toBe(true);
  });

  it("updates the list row immediately after a manual run starts", async () => {
    apiMocks.listAutomations.mockResolvedValue([makeAutomation()]);
    apiMocks.runAutomationNow.mockResolvedValue(
      makeRun({
        status: "running",
        scheduledFor: "2026-05-10T02:00:00.000Z",
        startedAt: "2026-05-10T02:00:10.000Z",
        finishedAt: null,
      }),
    );

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AutomationsListPage layout="panel" />
        </QueryClientProvider>,
      );
    });

    await flushEffects();
    await flushEffects();

    await act(async () => {
      findButtonByAriaLabel("Run now Nightly audit").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await flushEffects();

    expect(apiMocks.runAutomationNow).toHaveBeenCalled();
    expect(apiMocks.runAutomationNow.mock.calls[0]?.[0]).toBe("automation-1");
    expect(document.body.textContent).toContain("Running");
    expect(findButtonByAriaLabel("Run now Nightly audit").disabled).toBe(true);
  });

  it("does not invalidate automation runs directly after a list manual run succeeds", async () => {
    apiMocks.listAutomations.mockResolvedValue([makeAutomation()]);
    apiMocks.runAutomationNow.mockResolvedValue(
      makeRun({
        status: "running",
        scheduledFor: "2026-05-10T02:00:00.000Z",
        startedAt: "2026-05-10T02:00:10.000Z",
        finishedAt: null,
      }),
    );

    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AutomationsListPage layout="panel" />
        </QueryClientProvider>,
      );
    });

    await flushEffects();
    await flushEffects();

    await act(async () => {
      findButtonByAriaLabel("Run now Nightly audit").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await flushEffects();

    expect(invalidateQueriesSpy).toHaveBeenCalledWith({ queryKey: queryKeys.automations.detail("automation-1") });
    expect(automationRunsHooksMock.requestAutomationRunsLiveRefresh).toHaveBeenCalledWith(queryClient, "automation-1");
    expect(invalidateQueriesSpy).not.toHaveBeenCalledWith({ queryKey: queryKeys.automations.runs("automation-1") });
  });

  it("preserves the selected project filter after the list refreshes from an external create", async () => {
    const repoOne = makeRepository();
    const repoTwo = makeRepository({
      id: "repo-2",
      name: "other-repo",
      rootPath: "/tmp/other-repo",
      worktrees: [
        {
          id: "wt-2",
          repositoryId: "repo-2",
          branch: "main",
          path: "/tmp/other-repo",
          status: "active",
          baseBranch: "main",
          branchRenamed: false,
          lastCreateError: null,
          lastDeleteError: null,
          createdAt: "2026-05-10T10:00:00.000Z",
          updatedAt: "2026-05-10T10:00:00.000Z",
        },
      ],
    });

    useRepositoriesMock.useRepositories.mockReturnValue({
      data: [repoOne, repoTwo],
      isLoading: false,
    });
    apiMocks.listAutomations.mockImplementation(async (filters?: { repositoryId?: string; enabled?: boolean }) => {
      if (filters?.repositoryId === "repo-2") {
        return [
          makeAutomation({
            id: "automation-2",
            repositoryId: "repo-2",
            targetWorktreeId: "wt-2",
            name: "Other repo audit",
          }),
        ];
      }
      return [];
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AutomationsListPage layout="panel" />
        </QueryClientProvider>,
      );
    });

    await flushEffects();
    await flushEffects();

    await chooseSelectOption("Project filter", "other-repo");

    expect(findButtonByAriaLabel("Project filter").textContent).toContain("other-repo");

    useRepositoriesMock.useRepositories.mockReturnValue({
      data: [],
      isLoading: true,
    });
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AutomationsListPage layout="panel" />
        </QueryClientProvider>,
      );
    });
    await flushEffects();

    useRepositoriesMock.useRepositories.mockReturnValue({
      data: [repoOne, repoTwo],
      isLoading: false,
    });
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AutomationsListPage layout="panel" />
        </QueryClientProvider>,
      );
    });
    await flushEffects();

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.automations.lists });
    });
    await flushEffects();
    await flushEffects();

    expect(findButtonByAriaLabel("Project filter").textContent).toContain("other-repo");
    expect(document.body.textContent).toContain("Other repo audit");
  });
});

describe("AutomationDetailPage", () => {
  it("renders a simplified details sidebar with straightforward sections", async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AutomationDetailPage automationId="automation-1" />
        </QueryClientProvider>,
      );
    });

    await flushEffects();
    await flushEffects();
    await flushEffects();

    expect(document.body.textContent).toContain("Configuration");
    expect(document.body.textContent).toContain("Runs");
    expect(document.body.textContent).toContain("Versions");
    expect(document.body.textContent).toContain("Project");
    expect(document.body.textContent).toContain("Target");
    expect(document.body.textContent).toContain("Session");
    expect(findButtonByAriaLabel("Select root or worktree").textContent).toContain("Root");
    expect(findButtonByAriaLabel("Select schedule").textContent).toContain("Daily at 9:00 AM");
    expect(findButtonByAriaLabel("Select automation session").textContent).toContain("Codex");
    expect(document.body.textContent).not.toContain("Access");
    expect(document.body.querySelector('[data-testid="automation-runs-live-status"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="workspace-live-error-toast"]')).toBeNull();
  });

  it("shows a global live update toast only when automation runs live updates fail", async () => {
    automationRunsHooksMock.useAutomationRuns.mockReturnValue({
      data: [makeRun()],
      isLoading: false,
      isFetching: false,
      connectionState: "exhausted",
      error: new Error("Automation runs live stream exhausted"),
      refetch: vi.fn(),
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AutomationDetailPage automationId="automation-1" />
        </QueryClientProvider>,
      );
    });

    await flushEffects();
    await flushEffects();
    await flushEffects();

    const liveErrorToast = document.body.querySelector<HTMLElement>('[data-testid="workspace-live-error-toast"]');
    if (!liveErrorToast) {
      throw new Error("Expected live update error toast");
    }

    expect(liveErrorToast.textContent).toContain("Live updates unavailable");
    expect(liveErrorToast.textContent).toContain("Automation runs");
    expect(liveErrorToast.textContent).toContain("Automation runs live stream exhausted");
  });

  it("disables Run now and explains the problem when a root automation has no active root worktree", async () => {
    useRepositoriesMock.useRepositories.mockReturnValue({
      data: [makeRepository({
        worktrees: [
          {
            id: "wt-feature",
            repositoryId: "repo-1",
            branch: "feat/runtime-live",
            path: "/tmp/codesymphony-worktrees/feat-runtime-live",
            status: "active",
            baseBranch: "main",
            branchRenamed: false,
            lastCreateError: null,
            lastDeleteError: null,
            createdAt: "2026-05-10T10:00:00.000Z",
            updatedAt: "2026-05-10T10:00:00.000Z",
          },
        ],
      })],
      isLoading: false,
    });
    apiMocks.getAutomation.mockResolvedValue(makeAutomation({
      latestRun: null,
      targetMode: "repo_root",
      targetWorktreeId: "wt-feature",
    }));
    automationRunsHooksMock.useAutomationRuns.mockReturnValue({
      data: [],
      isLoading: false,
      isFetching: false,
      connectionState: "healthy",
      error: null,
      refetch: vi.fn(),
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AutomationDetailPage automationId="automation-1" />
        </QueryClientProvider>,
      );
    });

    await flushEffects();
    await flushEffects();
    await flushEffects();

    expect(findButton("Run now").disabled).toBe(true);
    expect(document.body.textContent).toContain("Repository root worktree is not available");
  });

  it("disables Run now after the latest root run fails because the worktree path is gone", async () => {
    const failedRun = makeRun({
      status: "failed",
      error: "Worktree path not found: /tmp/codesymphony. Create a new worktree from Repository panel.",
      summary: null,
      finishedAt: "2026-05-10T02:00:20.000Z",
    });

    apiMocks.getAutomation.mockResolvedValue(makeAutomation({
      latestRun: failedRun,
      targetMode: "repo_root",
    }));
    automationRunsHooksMock.useAutomationRuns.mockReturnValue({
      data: [failedRun],
      isLoading: false,
      isFetching: false,
      connectionState: "healthy",
      error: null,
      refetch: vi.fn(),
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AutomationDetailPage automationId="automation-1" />
        </QueryClientProvider>,
      );
    });

    await flushEffects();
    await flushEffects();
    await flushEffects();

    expect(findButton("Run now").disabled).toBe(true);
    expect(document.body.textContent).toContain("Repository root worktree is not available");
  });

  it("saves the latest prompt text from the detail editor", async () => {
    const currentAutomation = makeAutomation({
      prompt: "Inspect the repository root and summarize the next action.",
      latestRun: makeRun(),
    });
    const updatedAutomation = makeAutomation({
      prompt: "List one obvious file and the branch name.",
      latestRun: makeRun(),
    });

    apiMocks.getAutomation.mockResolvedValue(currentAutomation);
    apiMocks.updateAutomation.mockResolvedValue(updatedAutomation);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AutomationDetailPage automationId="automation-1" />
        </QueryClientProvider>,
      );
    });

    await flushEffects();
    await flushEffects();
    await flushEffects();

    const promptField = document.body.querySelector('[data-testid="automation-detail-prompt-editor"]');

    if (!(promptField instanceof HTMLElement)) {
      throw new Error("Prompt field not found");
    }

    expect(getEditorText(promptField)).toContain(currentAutomation.prompt);

    await setEditorValue(promptField, "Temporary prompt");
    await setEditorValue(promptField, updatedAutomation.prompt);

    await act(async () => {
      findButton("Save changes").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await flushEffects();
    await flushEffects();

    expect(apiMocks.updateAutomation).toHaveBeenCalledWith("automation-1", expect.objectContaining({
      prompt: updatedAutomation.prompt,
    }));
    expect(getEditorText(promptField)).toContain(updatedAutomation.prompt);
    expect(getEditorText(promptField)).not.toContain(currentAutomation.prompt);
  });

  it("updates the prompt editor after restoring a previous prompt version", async () => {
    const currentAutomation = makeAutomation({
      prompt: "Smoke-test simplified automation UI, updated after redesign.",
      latestRun: makeRun(),
    });
    const restoredAutomation = makeAutomation({
      prompt: "Smoke-test simplified automation UI.",
      latestRun: makeRun(),
    });

    apiMocks.getAutomation
      .mockResolvedValueOnce(currentAutomation)
      .mockResolvedValueOnce(restoredAutomation);
    apiMocks.restoreAutomationPromptVersion.mockResolvedValue(restoredAutomation);
    apiMocks.listAutomationPromptVersions.mockResolvedValue([
      makeVersion({
        id: "version-restore",
        content: restoredAutomation.prompt,
        source: "manual",
      }),
    ]);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AutomationDetailPage automationId="automation-1" />
        </QueryClientProvider>,
      );
    });

    await flushEffects();
    await flushEffects();
    await flushEffects();

    const promptField = document.body.querySelector('[data-testid="automation-detail-prompt-editor"]');

    if (!(promptField instanceof HTMLElement)) {
      throw new Error("Prompt field not found");
    }

    expect(getEditorText(promptField)).toContain(currentAutomation.prompt);

    await act(async () => {
      findButton("Restore").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await flushEffects();
    await flushEffects();
    await flushEffects();

    expect(apiMocks.restoreAutomationPromptVersion).toHaveBeenCalledWith("automation-1", "version-restore");
    expect(getEditorText(promptField)).toContain(restoredAutomation.prompt);
  });

  it("refreshes the editable fields after an external automation update when there are no unsaved edits", async () => {
    const currentAutomation = makeAutomation({
      name: "Nightly audit",
      prompt: "Inspect the repository root and summarize the next action.",
      latestRun: makeRun(),
    });
    const updatedAutomation = makeAutomation({
      name: "Nightly audit v2",
      prompt: "List one obvious file and the branch name.",
      latestRun: makeRun(),
    });

    apiMocks.getAutomation.mockResolvedValue(currentAutomation);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AutomationDetailPage automationId="automation-1" layout="panel" onBack={vi.fn()} />
        </QueryClientProvider>,
      );
    });

    await flushEffects();
    await flushEffects();
    await flushEffects();

    const titleInput = findInputByPlaceholder("Automation title");
    const promptField = document.body.querySelector('[data-testid="automation-detail-prompt-editor"]');
    if (!(promptField instanceof HTMLElement)) {
      throw new Error("Prompt field not found");
    }

    expect(titleInput.value).toBe(currentAutomation.name);
    expect(getEditorText(promptField)).toContain(currentAutomation.prompt);

    await act(async () => {
      queryClient.setQueryData(queryKeys.automations.detail("automation-1"), updatedAutomation);
    });
    await flushEffects();
    await flushEffects();

    expect(titleInput.value).toBe(updatedAutomation.name);
    expect(getEditorText(promptField)).toContain(updatedAutomation.prompt);
  });

  it("returns to the automation list after an external delete removes the current detail", async () => {
    const onBack = vi.fn();
    apiMocks.getAutomation
      .mockResolvedValueOnce(makeAutomation({ latestRun: makeRun() }))
      .mockRejectedValue(new Error("Automation not found"));

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AutomationDetailPage automationId="automation-1" layout="panel" onBack={onBack} />
        </QueryClientProvider>,
      );
    });

    await flushEffects();
    await flushEffects();
    await flushEffects();

    expect(document.body.textContent).toContain("Nightly audit");

    await act(async () => {
      await queryClient.refetchQueries({ queryKey: queryKeys.automations.detail("automation-1"), type: "active" });
    });
    await flushEffects();
    await flushEffects();
    await flushEffects();

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("opens a run through the workspace callback instead of router navigation in panel mode", async () => {
    const onOpenRun = vi.fn();

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <WorkspaceAutomationsPanel
            automationId="automation-1"
            onOpenAutomation={vi.fn()}
            onBack={vi.fn()}
            onOpenRun={onOpenRun}
          />
        </QueryClientProvider>,
      );
    });

    await flushEffects();
    await flushEffects();
    await flushEffects();
    await flushEffects();

    await act(async () => {
      findButton("Open").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onOpenRun).toHaveBeenCalledWith(expect.objectContaining({
      id: "run-1",
      worktreeId: "wt-1",
      threadId: "thread-1",
    }), "repo-1");
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("uses the active project filter as the default project when opening a new automation", async () => {
    const repoOne = makeRepository();
    const repoTwo = makeRepository({
      id: "repo-2",
      name: "other-repo",
      rootPath: "/tmp/other-repo",
      worktrees: [
        {
          id: "wt-2",
          repositoryId: "repo-2",
          branch: "main",
          path: "/tmp/other-repo",
          status: "active",
          baseBranch: "main",
          branchRenamed: false,
          lastCreateError: null,
          lastDeleteError: null,
          createdAt: "2026-05-10T10:00:00.000Z",
          updatedAt: "2026-05-10T10:00:00.000Z",
        },
      ],
    });

    useRepositoriesMock.useRepositories.mockReturnValue({
      data: [repoOne, repoTwo],
      isLoading: false,
    });
    apiMocks.listAutomations.mockResolvedValue([]);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AutomationsListPage layout="panel" />
        </QueryClientProvider>,
      );
    });

    await flushEffects();
    await flushEffects();

    await chooseSelectOption("Project filter", "other-repo");

    await act(async () => {
      findButton("New automation").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushEffects();

    expect(findButtonByAriaLabel("Select project").textContent).toContain("other-repo");
  });

  it("preserves the active project filter when workspace create mode toggles", async () => {
    const repoOne = makeRepository();
    const repoTwo = makeRepository({
      id: "repo-2",
      name: "other-repo",
      rootPath: "/tmp/other-repo",
      worktrees: [
        {
          id: "wt-2",
          repositoryId: "repo-2",
          branch: "main",
          path: "/tmp/other-repo",
          status: "active",
          baseBranch: "main",
          branchRenamed: false,
          lastCreateError: null,
          lastDeleteError: null,
          createdAt: "2026-05-10T10:00:00.000Z",
          updatedAt: "2026-05-10T10:00:00.000Z",
        },
      ],
    });

    useRepositoriesMock.useRepositories.mockReturnValue({
      data: [repoOne, repoTwo],
      isLoading: false,
    });
    apiMocks.listAutomations.mockResolvedValue([]);

    const onCreateDialogOpenChange = vi.fn();

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <WorkspaceAutomationsPanel
            create={false}
            prefills={{ repositoryId: "repo-1", worktreeId: "wt-1" }}
            onOpenAutomation={vi.fn()}
            onBack={vi.fn()}
            onCreateDialogOpenChange={onCreateDialogOpenChange}
          />
        </QueryClientProvider>,
      );
    });

    await flushEffects();
    await flushEffects();

    await chooseSelectOption("Project filter", "other-repo");
    expect(findButtonByAriaLabel("Project filter").textContent).toContain("other-repo");

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <WorkspaceAutomationsPanel
            create={true}
            prefills={{ repositoryId: "repo-1", worktreeId: "wt-1" }}
            onOpenAutomation={vi.fn()}
            onBack={vi.fn()}
            onCreateDialogOpenChange={onCreateDialogOpenChange}
          />
        </QueryClientProvider>,
      );
    });

    await flushEffects();

    expect(findButtonByAriaLabel("Select project").textContent).toContain("other-repo");

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <WorkspaceAutomationsPanel
            create={false}
            prefills={{ repositoryId: "repo-1", worktreeId: "wt-1" }}
            onOpenAutomation={vi.fn()}
            onBack={vi.fn()}
            onCreateDialogOpenChange={onCreateDialogOpenChange}
          />
        </QueryClientProvider>,
      );
    });

    await flushEffects();

    expect(findButtonByAriaLabel("Project filter").textContent).toContain("other-repo");
  });
});
