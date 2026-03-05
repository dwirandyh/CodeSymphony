import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatEvent } from "@codesymphony/shared-types";
import { ToolLogsPanel } from "./ToolLogsPanel";

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
    messageId: null,
    idx: 0,
    type: "tool.started",
    payload: { toolName: "Read" },
    timestamp: new Date().toISOString(),
    ...overrides,
  } as ChatEvent;
}

describe("ToolLogsPanel", () => {
  it("shows empty message when no events", () => {
    act(() => {
      root.render(<ToolLogsPanel toolEvents={[]} />);
    });
    expect(container.textContent).toContain("No tool activity yet");
  });

  it("renders the Checks heading", () => {
    act(() => {
      root.render(<ToolLogsPanel toolEvents={[]} />);
    });
    expect(container.textContent).toContain("Checks");
  });

  it("renders tool events with index and type", () => {
    const events = [
      makeEvent({ id: "e1", idx: 5, type: "tool.started" }),
      makeEvent({ id: "e2", idx: 6, type: "tool.finished" }),
    ];
    act(() => {
      root.render(<ToolLogsPanel toolEvents={events} />);
    });
    expect(container.textContent).toContain("#5");
    expect(container.textContent).toContain("tool.started");
    expect(container.textContent).toContain("#6");
    expect(container.textContent).toContain("tool.finished");
  });
});
