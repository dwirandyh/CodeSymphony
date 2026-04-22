import { describe, expect, it } from "vitest";
import { shortenCommandForSummary } from "./toolEventUtils";

describe("shortenCommandForSummary", () => {
  it("unwraps shell -lc wrappers before shortening path-heavy commands", () => {
    expect(
      shortenCommandForSummary("/bin/zsh -lc 'touch /tmp/codesymphony-plan-mode-dogfood.txt && rm /tmp/codesymphony-plan-mode-dogfood.txt'"),
    ).toBe("touch codesymphony-plan-mode-dogfood.txt && rm codesymphony-plan-mode-dogfood.txt");
  });

  it("keeps direct commands readable without leaking full paths", () => {
    expect(
      shortenCommandForSummary("git diff -- apps/web/src/components/workspace/chat-message-list/TimelineItem.tsx"),
    ).toBe("git diff -- TimelineItem.tsx");
  });
});
