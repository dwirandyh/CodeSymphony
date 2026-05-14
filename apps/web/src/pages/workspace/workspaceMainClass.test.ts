import { describe, expect, it } from "vitest";
import {
  getWorkspaceHeaderContainerClassName,
  getWorkspaceMainClassName,
} from "./workspaceMainClass";

describe("getWorkspaceMainClassName", () => {
  it("removes desktop horizontal padding for chat sessions", () => {
    const className = getWorkspaceMainClassName({
      activeView: "chat",
      mobileReposOverlayOpen: false,
    });

    expect(className).not.toContain("lg:px-3");
    expect(className).toContain("lg:pt-3");
  });

  it("keeps desktop horizontal padding for non-chat, non-file views", () => {
    const className = getWorkspaceMainClassName({
      activeView: "review",
      mobileReposOverlayOpen: false,
    });

    expect(className).toContain("lg:px-3");
  });

  it("keeps header shell horizontal padding for chat sessions", () => {
    const className = getWorkspaceHeaderContainerClassName({
      activeView: "chat",
    });

    expect(className).toContain("px-1.5");
    expect(className).toContain("sm:px-2.5");
    expect(className).toContain("lg:px-3");
  });

  it("keeps header shell horizontal padding for file view", () => {
    const className = getWorkspaceHeaderContainerClassName({
      activeView: "file",
    });

    expect(className).toContain("lg:px-3");
  });
});
