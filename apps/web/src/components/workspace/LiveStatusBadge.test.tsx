import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LiveStatusBadge } from "./LiveStatusBadge";

describe("LiveStatusBadge", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders the worst visible state across live domains", () => {
    act(() => {
      root.render(
        <LiveStatusBadge
          data-testid="live-status"
          items={[
            { domain: "chat_thread", connectionState: "healthy" },
            { domain: "git_status", connectionState: "reconnecting" },
            { domain: "repository_reviews", connectionState: "healthy" },
          ]}
        />,
      );
    });

    const badge = container.querySelector<HTMLElement>('[data-testid="live-status"]');
    if (!badge) {
      throw new Error("Live status badge not found");
    }

    expect(badge.textContent).toContain("Reconnecting");
    expect(badge.getAttribute("title")).toContain("Chat stream: Live");
    expect(badge.getAttribute("title")).toContain("Git status: Reconnecting");
    expect(badge.getAttribute("title")).toContain("persisted replay");
    expect(badge.getAttribute("title")).toContain("workspace socket");
    expect(badge.getAttribute("title")).toContain("snapshot stream");
  });

  it("renders nothing when there are no active live states", () => {
    act(() => {
      root.render(
        <LiveStatusBadge
          items={[
            { domain: "chat_thread", connectionState: null },
            { domain: "git_status", connectionState: null },
          ]}
        />,
      );
    });

    expect(container.textContent).toBe("");
  });

  it("renders unavailable when an exhausted resource reports a missing worktree", () => {
    act(() => {
      root.render(
        <LiveStatusBadge
          data-testid="live-status"
          items={[
            { domain: "chat_thread", connectionState: "healthy" },
            {
              domain: "git_status",
              connectionState: "exhausted",
              errorMessage: "Worktree path not found: /tmp/codesymphony. Create a new worktree from Repository panel.",
            },
          ]}
        />,
      );
    });

    const badge = container.querySelector<HTMLElement>('[data-testid="live-status"]');
    if (!badge) {
      throw new Error("Live status badge not found");
    }

    expect(badge.textContent).toContain("Unavailable");
    expect(badge.getAttribute("title")).toContain("Git status: Unavailable");
    expect(badge.getAttribute("title")).toContain("Worktree path not found");
  });

  it("renders switching when a scope change is still settling", () => {
    act(() => {
      root.render(
        <LiveStatusBadge
          data-testid="live-status"
          items={[
            { domain: "chat_thread", connectionState: "healthy" },
            {
              domain: "git_status",
              connectionState: "reconnecting",
              displayStateOverride: "switching",
            },
          ]}
        />,
      );
    });

    const badge = container.querySelector<HTMLElement>('[data-testid="live-status"]');
    if (!badge) {
      throw new Error("Live status badge not found");
    }

    expect(badge.textContent).toContain("Switching");
    expect(badge.getAttribute("title")).toContain("Git status: Switching");
  });
});
