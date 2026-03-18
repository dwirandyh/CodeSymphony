import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "@codesymphony/shared-types";
import { ActivityTabs } from "./ActivityTabs";

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

function makeEvent(overrides: Partial<ChatEvent> = {}): ChatEvent {
  return {
    id: "e1",
    threadId: "t1",
    idx: 0,
    type: "tool.started",
    payload: {},
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("ActivityTabs", () => {
  it("renders Chat and Tool Logs tab buttons", () => {
    act(() => {
      root.render(
        <ActivityTabs
          activeTab="chat"
          toolEvents={[]}
          onTabChange={vi.fn()}
          chatContent={<div>chat content</div>}
        />
      );
    });
    expect(container.textContent).toContain("Chat");
    expect(container.textContent).toContain("Tool Logs");
  });

  it("renders chatContent when chat tab active", () => {
    act(() => {
      root.render(
        <ActivityTabs
          activeTab="chat"
          toolEvents={[]}
          onTabChange={vi.fn()}
          chatContent={<div>Hello from chat</div>}
        />
      );
    });
    expect(container.textContent).toContain("Hello from chat");
  });

  it("shows no tool activity message when toolEvents is empty on logs tab", () => {
    act(() => {
      root.render(
        <ActivityTabs
          activeTab="logs"
          toolEvents={[]}
          onTabChange={vi.fn()}
          chatContent={<div />}
        />
      );
    });
    expect(container.textContent).toContain("No tool activity yet");
  });

  it("renders tool events on logs tab", () => {
    const events = [
      makeEvent({ id: "e1", idx: 0, type: "tool.started" }),
      makeEvent({ id: "e2", idx: 1, type: "tool.finished" }),
    ];
    act(() => {
      root.render(
        <ActivityTabs
          activeTab="logs"
          toolEvents={events}
          onTabChange={vi.fn()}
          chatContent={<div />}
        />
      );
    });
    expect(container.textContent).toContain("[0] tool.started");
    expect(container.textContent).toContain("[1] tool.finished");
  });

  it("renders Activity title", () => {
    act(() => {
      root.render(
        <ActivityTabs
          activeTab="chat"
          toolEvents={[]}
          onTabChange={vi.fn()}
          chatContent={<div />}
        />
      );
    });
    expect(container.textContent).toContain("Activity");
  });
});
