import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useGateRequestNavigation } from "./useGateRequestNavigation";

type Req = { requestId: string };
type Nav = ReturnType<typeof useGateRequestNavigation<Req>>;

let latestNav: Nav | null = null;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function Harness({ list }: { list: Req[] }) {
  const nav = useGateRequestNavigation(list);
  latestNav = nav;
  return null;
}

function renderHarness(list: Req[]) {
  const activeRoot = root;
  if (!activeRoot || !container) {
    throw new Error("test root not initialized");
  }
  act(() => {
    activeRoot.render(<Harness list={list} />);
  });
}

describe("useGateRequestNavigation", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latestNav = null;
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = null;
    container = null;
    latestNav = null;
  });

  it("selects first request when list becomes non-empty", () => {
    renderHarness([]);
    expect(latestNav?.activeRequest).toBeNull();
    expect(latestNav?.activeIndex).toBe(-1);

    renderHarness([{ requestId: "a" }, { requestId: "b" }]);
    expect(latestNav?.activeRequest?.requestId).toBe("a");
    expect(latestNav?.activeIndex).toBe(0);
    expect(latestNav?.hasMultiple).toBe(true);
  });

  it("moves previous and next across pending requests", () => {
    renderHarness([{ requestId: "a" }, { requestId: "b" }, { requestId: "c" }]);
    expect(latestNav?.activeRequest?.requestId).toBe("a");

    act(() => {
      latestNav?.showNext();
    });
    expect(latestNav?.activeRequest?.requestId).toBe("b");

    act(() => {
      latestNav?.showPrevious();
    });
    expect(latestNav?.activeRequest?.requestId).toBe("a");
  });

  it("clears active request when pending list empties", () => {
    renderHarness([{ requestId: "a" }]);
    expect(latestNav?.activeRequest?.requestId).toBe("a");

    renderHarness([]);
    expect(latestNav?.activeRequest).toBeNull();
    expect(latestNav?.activeIndex).toBe(-1);
  });
});
