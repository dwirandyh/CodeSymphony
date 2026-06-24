import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RootErrorBoundary } from "./RootErrorBoundary";

const debugLogMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/debugLog", () => ({
  debugLog: debugLogMock,
}));

function Bomb({ message }: { message: string }): never {
  throw new Error(message);
}

describe("RootErrorBoundary", () => {
  let container: HTMLDivElement;
  let root: Root;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugLogMock.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // React logs caught render errors to console.error; silence the noise.
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    consoleErrorSpy.mockRestore();
  });

  it("reports the crash through the debug log when a child throws during render", () => {
    flushSync(() => {
      root.render(
        <RootErrorBoundary>
          <Bomb message="Cannot convert undefined or null to object" />
        </RootErrorBoundary>,
      );
    });

    const crashEntry = debugLogMock.mock.calls.find(([source]) => source === "app.crash");
    expect(crashEntry).toBeDefined();

    const [, message, data, options] = crashEntry!;
    expect(message).toBe("Cannot convert undefined or null to object");
    expect((data as { stack?: string }).stack).toEqual(expect.any(String));
    expect((data as { componentStack?: string }).componentStack).toContain("Bomb");
    expect((options as { force?: boolean }).force).toBe(true);
  });
});
