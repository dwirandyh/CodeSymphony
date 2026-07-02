import type { ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveBackgroundJob } from "../../pages/workspace/backgroundJobUtils";
import { BackgroundJobsShelf } from "./BackgroundJobsShelf";

const sampleJobs: ActiveBackgroundJob[] = [
  {
    id: "background:mon-1",
    toolUseId: "mon-1",
    kind: "monitor",
    label: "errors in deploy.log",
    status: "running",
    elapsedSeconds: 90,
    startIdx: 1,
    createdAt: "2025-01-01T00:00:00.000Z",
  },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => {
    root.unmount();
  });
  container.remove();
});

function renderShelf(props: ComponentProps<typeof BackgroundJobsShelf>) {
  flushSync(() => {
    root.render(<BackgroundJobsShelf {...props} />);
  });
}

describe("BackgroundJobsShelf", () => {
  it("renders nothing when there are no active jobs", () => {
    renderShelf({ jobs: [] });
    expect(container.firstChild).toBeNull();
  });

  it("renders an attached shelf with monitoring count", () => {
    renderShelf({ jobs: sampleJobs, attached: true });

    const shelf = container.querySelector('[data-testid="attached-background-jobs-shelf"]');
    expect(shelf).not.toBeNull();
    expect(shelf?.textContent).toContain("1 monitoring");
  });

  it("shows job label and elapsed time when expanded", () => {
    renderShelf({ jobs: sampleJobs, attached: true });

    flushSync(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Expand monitoring"]')?.click();
    });

    expect(container.textContent).toContain("errors in deploy.log");
    expect(container.textContent).toContain("1m 30s");
  });

  it("shows stop control as disabled until per-job stop is available", () => {
    renderShelf({ jobs: sampleJobs, attached: true });

    flushSync(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Expand monitoring"]')?.click();
    });

    const stopButton = container.querySelector<HTMLButtonElement>('button[aria-label="Stop monitoring"]');
    expect(stopButton).not.toBeNull();
    expect(stopButton?.disabled).toBe(true);
  });

  it("invokes onStopJob when provided and stop is clicked", () => {
    const onStopJob = vi.fn();
    renderShelf({ jobs: sampleJobs, attached: true, onStopJob });

    flushSync(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Expand monitoring"]')?.click();
    });
    flushSync(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Stop monitoring"]')?.click();
    });

    expect(onStopJob).toHaveBeenCalledWith("mon-1");
  });
});