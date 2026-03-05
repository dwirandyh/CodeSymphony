import { describe, it, expect } from "vitest";
import { getAppIcon } from "./appIcons";

describe("getAppIcon", () => {
  it("returns an icon for known editor ids", () => {
    for (const id of ["vscode", "cursor", "zed", "intellij", "webstorm", "sublime", "xcode", "fleet", "nova"]) {
      expect(getAppIcon(id)).toBeDefined();
    }
  });

  it("returns an icon for known terminal ids", () => {
    for (const id of ["terminal", "iterm", "warp", "ghostty"]) {
      expect(getAppIcon(id)).toBeDefined();
    }
  });

  it("returns default icon for unknown app id", () => {
    const defaultIcon = getAppIcon("unknown-app");
    expect(defaultIcon).toBeDefined();
    expect(defaultIcon).toBe(getAppIcon("some-other-unknown"));
  });

  it("known apps differ from unknown only when expected", () => {
    const cursorIcon = getAppIcon("cursor");
    const unknownIcon = getAppIcon("unknown");
    expect(cursorIcon).toBe(unknownIcon);
  });
});
