import { describe, expect, it } from "vitest";
import {
  isLikelyLanHost,
  isLikelyMobileUserAgent,
  shouldShowMobileDeviceViewerControls,
} from "./deviceViewerEnvironment";

describe("deviceViewerEnvironment", () => {
  describe("isLikelyLanHost", () => {
    it("accepts private LAN ipv4 addresses", () => {
      expect(isLikelyLanHost("192.168.1.7")).toBe(true);
      expect(isLikelyLanHost("10.0.0.8")).toBe(true);
      expect(isLikelyLanHost("172.20.10.5")).toBe(true);
      expect(isLikelyLanHost("device.local")).toBe(true);
    });

    it("rejects loopback and public-style hosts", () => {
      expect(isLikelyLanHost("localhost")).toBe(false);
      expect(isLikelyLanHost("127.0.0.1")).toBe(false);
      expect(isLikelyLanHost("example.com")).toBe(false);
      expect(isLikelyLanHost("8.8.8.8")).toBe(false);
    });
  });

  describe("isLikelyMobileUserAgent", () => {
    it("detects coarse pointer or common mobile user agents", () => {
      expect(isLikelyMobileUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", false)).toBe(true);
      expect(isLikelyMobileUserAgent("Mozilla/5.0", true)).toBe(true);
    });

    it("rejects desktop browsers without coarse pointers", () => {
      expect(isLikelyMobileUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", false)).toBe(false);
    });
  });

  describe("shouldShowMobileDeviceViewerControls", () => {
    it("shows controls only for mobile LAN browser access", () => {
      expect(shouldShowMobileDeviceViewerControls({
        coarsePointer: true,
        hostname: "192.168.1.7",
        protocol: "http:",
        userAgent: "Mozilla/5.0 (Android 15)",
      })).toBe(true);
    });

    it("hides controls for localhost or desktop access", () => {
      expect(shouldShowMobileDeviceViewerControls({
        coarsePointer: true,
        hostname: "localhost",
        protocol: "http:",
        userAgent: "Mozilla/5.0 (Android 15)",
      })).toBe(false);

      expect(shouldShowMobileDeviceViewerControls({
        coarsePointer: false,
        hostname: "192.168.1.7",
        protocol: "http:",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      })).toBe(false);
    });
  });
});
