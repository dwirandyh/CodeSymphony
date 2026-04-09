import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSlashCommands } from "./useSlashCommands";

vi.mock("../../../lib/api", () => ({
  api: {
    getSlashCommands: vi.fn().mockResolvedValue({
      commands: [{ name: "commit", description: "Create a commit", argumentHint: "" }],
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
  },
}));

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

function TestComponent({ worktreeId }: { worktreeId: string | null }) {
  const { commands, loading } = useSlashCommands(worktreeId);
  return <div>{loading ? "loading" : `count:${commands.length}`}</div>;
}

describe("useSlashCommands", () => {
  it("returns commands for an active worktree", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(
        <QueryClientProvider client={qc}>
          <TestComponent worktreeId="w1" />
        </QueryClientProvider>
      );
    });
    expect(container.textContent).toMatch(/loading|count:\d+/);
  });

  it("returns empty commands for null worktreeId", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(
        <QueryClientProvider client={qc}>
          <TestComponent worktreeId={null} />
        </QueryClientProvider>
      );
    });
    expect(container.textContent).toBeTruthy();
  });
});
