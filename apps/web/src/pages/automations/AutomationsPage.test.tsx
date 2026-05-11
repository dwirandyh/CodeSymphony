import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Automation, AutomationPromptVersion, AutomationRun, Repository } from "@codesymphony/shared-types";
import { AutomationDetailPage, AutomationsListPage } from "./AutomationsPage";

const navigateMock = vi.hoisted(() => vi.fn());
const apiMocks = vi.hoisted(() => ({
  listAutomations: vi.fn(),
  createAutomation: vi.fn(),
  getAutomation: vi.fn(),
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
    createAutomation: apiMocks.createAutomation,
    getAutomation: apiMocks.getAutomation,
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
    name: "Nightly audit",
    prompt: "Audit the repository and summarize the next actions.",
    enabled: true,
    agent: "codex",
    model: "gpt-5.4",
    modelProviderId: null,
    permissionMode: "default",
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
    await new Promise((resolve) => setTimeout(resolve, 0));
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

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  useRepositoriesMock.useRepositories.mockReturnValue({
    data: [makeRepository()],
    isLoading: false,
  });
  useModelProvidersMock.useModelProviders.mockReturnValue({ providers: [] });
  apiMocks.listAutomations.mockResolvedValue([]);
  apiMocks.createAutomation.mockResolvedValue(makeAutomation());
  apiMocks.getAutomation.mockResolvedValue(makeAutomation({ latestRun: makeRun() }));
  apiMocks.listAutomationRuns.mockResolvedValue([makeRun()]);
  apiMocks.listAutomationPromptVersions.mockResolvedValue([makeVersion()]);
  apiMocks.restoreAutomationPromptVersion.mockResolvedValue(makeAutomation());
  apiMocks.updateAutomation.mockResolvedValue(makeAutomation());
  apiMocks.runAutomationNow.mockResolvedValue(makeRun());
  apiMocks.deleteAutomation.mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root.unmount());
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
    expect(findButtonByAriaLabel("Select local or worktree").textContent).toContain("Local");
    expect(findButtonByAriaLabel("Select schedule").textContent).toContain("Daily at 9:00 AM");
    expect(findButtonByAriaLabel("Select automation agent and model").textContent).toContain("Claude");
    expect(findButtonByAriaLabel("Select automation access").textContent).toContain("Default");

    const titleInput = Array.from(document.body.querySelectorAll("input")).find((entry) => entry.getAttribute("placeholder") === "Automation title");
    const promptField = Array.from(document.body.querySelectorAll("textarea")).find((entry) => entry.getAttribute("placeholder")?.startsWith("Add prompt"));

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
      findButtonByAriaLabel("Select local or worktree"),
      findButtonByAriaLabel("Select schedule"),
      findButtonByAriaLabel("Select automation agent and model"),
      findButtonByAriaLabel("Select automation access"),
    ];

    for (const trigger of triggerButtons) {
      expect(trigger.className).toContain("text-[12px]");
      expect(trigger.className).toContain("hover:bg-secondary/40");
      expect(trigger.className).toContain("rounded-md");
    }
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
    const prompt = document.body.querySelector("textarea");
    if (!(textboxes[0] instanceof HTMLInputElement) || !(prompt instanceof HTMLTextAreaElement)) {
      throw new Error("Create form inputs not found");
    }

    await setInputValue(textboxes[0], "Automation smoke");
    await setInputValue(prompt, "Audit the repository and summarize the next actions.");

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
    const prompt = document.body.querySelector("textarea");
    if (!(textboxes[0] instanceof HTMLInputElement) || !(prompt instanceof HTMLTextAreaElement)) {
      throw new Error("Create form inputs not found");
    }

    await setInputValue(textboxes[0], "Automation smoke");
    await setInputValue(prompt, "Audit the repository and summarize the next actions.");

    await act(async () => {
      findButton("Create").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await flushEffects();

    expect(apiMocks.createAutomation).toHaveBeenCalledOnce();
    expect(onOpenAutomation).toHaveBeenCalledWith("automation-1");
    expect(navigateMock).not.toHaveBeenCalled();
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
    expect(document.body.textContent).toContain("Worktree");
    expect(document.body.textContent).toContain("Access");
    expect(document.body.textContent).toContain("Mode");
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

    const promptField = Array.from(document.body.querySelectorAll("textarea")).find(
      (entry) => entry.getAttribute("placeholder") === "Add prompt",
    );

    if (!(promptField instanceof HTMLTextAreaElement)) {
      throw new Error("Prompt field not found");
    }

    expect(promptField.value).toBe(currentAutomation.prompt);

    await act(async () => {
      findButton("Restore").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await flushEffects();
    await flushEffects();
    await flushEffects();

    expect(apiMocks.restoreAutomationPromptVersion).toHaveBeenCalledWith("automation-1", "version-restore");
    expect(promptField.value).toBe(restoredAutomation.prompt);
  });
});
