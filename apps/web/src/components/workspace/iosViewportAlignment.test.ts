import { describe, expect, it } from "vitest";
import { buildIosViewportGeometryKey, shouldRetainIosViewportAlignment } from "./iosViewportAlignment";

describe("iosViewportAlignment", () => {
  it("builds a stable geometry key from device and frame sizes", () => {
    expect(buildIosViewportGeometryKey({
      deviceHeight: 844,
      deviceWidth: 390,
      frameHeight: 1688,
      frameWidth: 780,
    })).toBe("780x1688:390x844");
  });

  it("returns null for incomplete geometry", () => {
    expect(buildIosViewportGeometryKey({
      deviceHeight: 844,
      deviceWidth: 390,
      frameHeight: 0,
      frameWidth: 780,
    })).toBeNull();
  });

  it("retains alignment only for the same stream geometry after a frame has already rendered", () => {
    expect(shouldRetainIosViewportAlignment({
      aligned: false,
      hasFrame: true,
      lastAlignedGeometryKey: "780x1688:390x844",
      nextGeometryKey: "780x1688:390x844",
    })).toBe(true);

    expect(shouldRetainIosViewportAlignment({
      aligned: false,
      hasFrame: true,
      lastAlignedGeometryKey: "780x1688:390x844",
      nextGeometryKey: "768x1662:390x844",
    })).toBe(false);

    expect(shouldRetainIosViewportAlignment({
      aligned: true,
      hasFrame: true,
      lastAlignedGeometryKey: "780x1688:390x844",
      nextGeometryKey: "780x1688:390x844",
    })).toBe(false);
  });
});
