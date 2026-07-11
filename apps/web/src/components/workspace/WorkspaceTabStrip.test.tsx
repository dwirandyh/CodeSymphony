import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TabItem } from "../../pages/workspace/editorGroups";
import {
  clearActiveEditorTabDragPayload,
  EDITOR_TAB_DRAG_MIME,
  writeEditorTabDragData,
} from "./editorTabDrag";
import { resolveSessionTabScrollLeft, WorkspaceTabStrip } from "./WorkspaceTabStrip";

function dispatchDragEvent(
  target: HTMLElement,
  type: "dragover" | "drop",
  clientX: number,
  dataTransfer: DataTransfer,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientX", { value: clientX });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  target.dispatchEvent(event);
}

function createDataTransferStub(): DataTransfer {
  const values = new Map<string, string>();
  const types: string[] = [];
  return {
    types,
    effectAllowed: "none",
    dropEffect: "none",
    setData(type: string, value: string) {
      values.set(type, value);
      if (!types.includes(type)) {
        types.push(type);
      }
    },
    getData(type: string) {
      return values.get(type) ?? "";
    },
  } as unknown as DataTransfer;
}

const tabs: TabItem[] = [
  { type: "chat", id: "thread-1" },
  { type: "file", id: "a.ts" },
  { type: "file", id: "b.ts" },
];

describe("WorkspaceTabStrip drag and drop", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    clearActiveEditorTabDragPayload();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    clearActiveEditorTabDragPayload();
    act(() => root.unmount());
    container.remove();
  });

  it("reorders within the group on drop with adjusted index", () => {
    const onReorderTab = vi.fn();
    act(() => {
      root.render(
        <WorkspaceTabStrip
          groupId="topLeft"
          tabs={tabs}
          activeTabId="thread-1"
          threads={[]}
          terminalTabs={[]}
          fileTabs={[]}
          onSelectTab={() => {}}
          onCloseTab={() => {}}
          onReorderTab={onReorderTab}
        />,
      );
    });

    const tablist = container.querySelector('[data-testid="session-tabs-scroll"]') as HTMLElement;
    const tabEls = tablist.querySelectorAll<HTMLElement>("[data-tab-index]");
    const firstTab = tabEls[0];
    if (!firstTab) {
      throw new Error("tab element missing");
    }

    const dataTransfer = createDataTransferStub();
    dataTransfer.setData(
      EDITOR_TAB_DRAG_MIME,
      JSON.stringify({
        sourceGroupId: "topLeft",
        sourceIndex: 0,
        tab: tabs[0],
      }),
    );

    const thirdTab = tabEls[2];
    if (!thirdTab) {
      throw new Error("third tab missing");
    }
    const rect = { left: 200, width: 80, right: 280 } as DOMRect;
    thirdTab.getBoundingClientRect = () => rect;

    act(() => {
      dispatchDragEvent(tablist, "dragover", 210, dataTransfer);
      dispatchDragEvent(tablist, "drop", 210, dataTransfer);
    });

    expect(onReorderTab).toHaveBeenCalledWith("thread-1", 1);
  });

  it("accepts cross-group dragover when custom MIME is hidden until drop", () => {
    const onDropTabFromOtherGroup = vi.fn();
    act(() => {
      root.render(
        <WorkspaceTabStrip
          groupId="topRight"
          tabs={[{ type: "file", id: "c.ts" }]}
          activeTabId="c.ts"
          threads={[]}
          terminalTabs={[]}
          fileTabs={[]}
          fillWidth
          onSelectTab={() => {}}
          onCloseTab={() => {}}
          onDropTabFromOtherGroup={onDropTabFromOtherGroup}
        />,
      );
    });

    const tablist = container.querySelector('[data-testid="editor-tab-bar-topRight"]') as HTMLElement;
    const dropTransfer = createDataTransferStub();
    writeEditorTabDragData(dropTransfer, {
      sourceGroupId: "topLeft",
      tab: { type: "file", id: "a.ts" },
    });

    const dragoverTransfer = createDataTransferStub();
    const tabEl = tablist.querySelector<HTMLElement>("[data-tab-index='0']");
    if (!tabEl) {
      throw new Error("target tab missing");
    }
    tabEl.getBoundingClientRect = () =>
      ({
        left: 40,
        width: 100,
        right: 140,
        top: 0,
        bottom: 30,
        height: 30,
        x: 40,
        y: 0,
        toJSON() {
          return {};
        },
      }) as DOMRect;

    let dragoverDefaultPrevented = false;
    act(() => {
      const dragover = new Event("dragover", { bubbles: true, cancelable: true });
      Object.defineProperty(dragover, "clientX", { value: 50 });
      Object.defineProperty(dragover, "dataTransfer", { value: dragoverTransfer });
      tablist.dispatchEvent(dragover);
      dragoverDefaultPrevented = dragover.defaultPrevented;
      dispatchDragEvent(tablist, "drop", 50, dropTransfer);
    });

    expect(dragoverDefaultPrevented).toBe(true);
    expect(onDropTabFromOtherGroup).toHaveBeenCalledWith(
      { type: "file", id: "a.ts" },
      "topLeft",
      0,
    );
  });

  it("accepts cross-group drop at computed index", () => {
    const onDropTabFromOtherGroup = vi.fn();
    act(() => {
      root.render(
        <WorkspaceTabStrip
          groupId="topRight"
          tabs={[{ type: "file", id: "c.ts" }]}
          activeTabId="c.ts"
          threads={[]}
          terminalTabs={[]}
          fileTabs={[]}
          fillWidth
          onSelectTab={() => {}}
          onCloseTab={() => {}}
          onDropTabFromOtherGroup={onDropTabFromOtherGroup}
        />,
      );
    });

    const tablist = container.querySelector('[data-testid="editor-tab-bar-topRight"]') as HTMLElement;
    const dataTransfer = createDataTransferStub();
    dataTransfer.setData(
      EDITOR_TAB_DRAG_MIME,
      JSON.stringify({
        sourceGroupId: "topLeft",
        tab: { type: "file", id: "a.ts" },
      }),
    );

    const tabEl = tablist.querySelector<HTMLElement>("[data-tab-index='0']");
    if (!tabEl) {
      throw new Error("target tab missing");
    }
    tabEl.getBoundingClientRect = () =>
      ({
        left: 40,
        width: 100,
        right: 140,
        top: 0,
        bottom: 30,
        height: 30,
        x: 40,
        y: 0,
        toJSON() {
          return {};
        },
      }) as DOMRect;

    act(() => {
      dispatchDragEvent(tablist, "dragover", 50, dataTransfer);
      dispatchDragEvent(tablist, "drop", 50, dataTransfer);
    });

    expect(onDropTabFromOtherGroup).toHaveBeenCalledWith(
      { type: "file", id: "a.ts" },
      "topLeft",
      0,
    );
  });

  it("notifies drag lifecycle callbacks", () => {
    const onTabDragStart = vi.fn();
    const onTabDragEnd = vi.fn();
    act(() => {
      root.render(
        <WorkspaceTabStrip
          groupId="topLeft"
          tabs={tabs}
          activeTabId="thread-1"
          threads={[]}
          terminalTabs={[]}
          fileTabs={[]}
          onSelectTab={() => {}}
          onCloseTab={() => {}}
          onTabDragStart={onTabDragStart}
          onTabDragEnd={onTabDragEnd}
        />,
      );
    });

    const draggable = container.querySelector("[draggable='true']") as HTMLElement;
    if (!draggable) {
      throw new Error("draggable tab missing");
    }

    act(() => {
      const dragStart = new Event("dragstart", { bubbles: true });
      Object.defineProperty(dragStart, "dataTransfer", {
        value: createDataTransferStub(),
      });
      draggable.dispatchEvent(dragStart);
      const tablist = container.querySelector('[data-testid="session-tabs-scroll"]') as HTMLElement;
      tablist.dispatchEvent(new Event("dragend", { bubbles: true }));
    });

    expect(onTabDragStart).toHaveBeenCalled();
    expect(onTabDragEnd).toHaveBeenCalled();
  });
});

describe("resolveSessionTabScrollLeft", () => {
  it("returns null when the selected tab is safely inside the strip", () => {
    expect(
      resolveSessionTabScrollLeft({
        currentScrollLeft: 40,
        regionWidth: 320,
        scrollWidth: 800,
        selectedLeftInRegion: 100,
        selectedWidth: 120,
        edgeInsetPx: 64,
      }),
    ).toBeNull();
  });

  it("centers a tab that sits past the right edge inset", () => {
    const next = resolveSessionTabScrollLeft({
      currentScrollLeft: 0,
      regionWidth: 320,
      scrollWidth: 800,
      selectedLeftInRegion: 260,
      selectedWidth: 140,
      edgeInsetPx: 64,
    });
    // selected center at 330 → target scroll 330 - 160 = 170
    expect(next).toBe(170);
  });

  it("clamps to the max scroll when the last tab cannot be centered", () => {
    const next = resolveSessionTabScrollLeft({
      currentScrollLeft: 100,
      regionWidth: 320,
      scrollWidth: 500,
      selectedLeftInRegion: 280,
      selectedWidth: 140,
      edgeInsetPx: 64,
    });
    expect(next).toBe(180);
  });
});

describe("WorkspaceTabStrip auto-scroll", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    clearActiveEditorTabDragPayload();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    clearActiveEditorTabDragPayload();
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function mockEdgeGeometry() {
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function getBoundingClientRect(
      this: HTMLElement,
    ) {
      if (this instanceof HTMLDivElement && this.dataset.testid === "session-tabs-scroll") {
        return {
          x: 0,
          y: 0,
          width: 320,
          height: 40,
          top: 0,
          right: 320,
          bottom: 40,
          left: 0,
          toJSON: () => ({}),
        } as DOMRect;
      }

      if (
        this instanceof HTMLButtonElement
        && this.getAttribute("role") === "tab"
        && this.getAttribute("aria-selected") === "true"
      ) {
        return {
          x: 260,
          y: 0,
          width: 140,
          height: 32,
          top: 0,
          right: 400,
          bottom: 32,
          left: 260,
          toJSON: () => ({}),
        } as DOMRect;
      }

      return originalGetBoundingClientRect.call(this);
    });
  }

  it("auto-scrolls via scrollLeft and never calls scrollIntoView", async () => {
    mockEdgeGeometry();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    const manyTabs: TabItem[] = [
      { type: "chat", id: "thread-1" },
      { type: "chat", id: "thread-2" },
      { type: "chat", id: "thread-3" },
      { type: "chat", id: "thread-4" },
    ];

    const threadProps = manyTabs.map((tab) => ({
      id: tab.id,
      title: tab.id,
      worktreeId: "wt",
      status: "idle",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })) as never;

    // Mount without auto-scroll so metrics can be attached before the first snap.
    act(() => {
      root.render(
        <WorkspaceTabStrip
          groupId="topLeft"
          tabs={manyTabs}
          activeTabId="thread-4"
          threads={threadProps}
          terminalTabs={[]}
          fileTabs={[]}
          enableScrollIntoView={false}
          onSelectTab={() => {}}
          onCloseTab={() => {}}
        />,
      );
    });
    await Promise.resolve();

    const scrollRegion = container.querySelector('[data-testid="session-tabs-scroll"]') as HTMLDivElement;
    Object.defineProperty(scrollRegion, "scrollWidth", { configurable: true, value: 800 });
    Object.defineProperty(scrollRegion, "clientWidth", { configurable: true, value: 320 });
    scrollRegion.scrollLeft = 0;

    act(() => {
      root.render(
        <WorkspaceTabStrip
          groupId="topLeft"
          tabs={manyTabs}
          activeTabId="thread-4"
          threads={threadProps}
          terminalTabs={[]}
          fileTabs={[]}
          enableScrollIntoView
          onSelectTab={() => {}}
          onCloseTab={() => {}}
        />,
      );
    });
    await Promise.resolve();

    expect(scrollIntoView).not.toHaveBeenCalled();
    // selected center 330 in 320-wide region from scrollLeft 0 → 170
    expect(scrollRegion.scrollLeft).toBe(170);
  });

  it("does not re-snap scroll when tabs array identity churns for the same selection", async () => {
    mockEdgeGeometry();

    const manyTabs: TabItem[] = [
      { type: "chat", id: "thread-1" },
      { type: "chat", id: "thread-2" },
      { type: "chat", id: "thread-3" },
      { type: "chat", id: "thread-4" },
    ];

    const renderStrip = (tabList: TabItem[]) => (
      <WorkspaceTabStrip
        groupId="topLeft"
        tabs={tabList}
        activeTabId="thread-4"
        threads={tabList.map((tab) => ({
          id: tab.id,
          title: tab.id,
          worktreeId: "wt",
          status: "idle",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })) as never}
        terminalTabs={[]}
        fileTabs={[]}
        enableScrollIntoView
        onSelectTab={() => {}}
        onCloseTab={() => {}}
      />
    );

    act(() => {
      root.render(renderStrip(manyTabs));
    });
    await Promise.resolve();

    const scrollRegion = container.querySelector('[data-testid="session-tabs-scroll"]') as HTMLDivElement;
    Object.defineProperty(scrollRegion, "scrollWidth", { configurable: true, value: 800 });
    Object.defineProperty(scrollRegion, "clientWidth", { configurable: true, value: 320 });

    // Force a selection change so auto-scroll applies with mocked scroll metrics.
    act(() => {
      root.render(
        <WorkspaceTabStrip
          groupId="topLeft"
          tabs={manyTabs}
          activeTabId="thread-1"
          threads={manyTabs.map((tab) => ({
            id: tab.id,
            title: tab.id,
            worktreeId: "wt",
            status: "idle",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })) as never}
          terminalTabs={[]}
          fileTabs={[]}
          enableScrollIntoView
          onSelectTab={() => {}}
          onCloseTab={() => {}}
        />,
      );
    });
    await Promise.resolve();

    act(() => {
      root.render(renderStrip([...manyTabs]));
    });
    await Promise.resolve();

    scrollRegion.scrollLeft = 42;

    // Churn tabs identity many times with the same active tab — must not yank scroll.
    for (let i = 0; i < 8; i++) {
      act(() => {
        root.render(renderStrip(manyTabs.map((tab) => ({ ...tab }))));
      });
      await Promise.resolve();
    }

    expect(scrollRegion.scrollLeft).toBe(42);
  });
});