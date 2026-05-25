import { describe, expect, it } from "vitest";
import { isPtyIoError } from "../src/services/ptyBackend";

describe("ptyBackend", () => {
  it("detects common PTY I/O errors", () => {
    expect(isPtyIoError({ code: "EBADF" })).toBe(true);
    expect(isPtyIoError({ code: "EIO" })).toBe(true);
    expect(isPtyIoError({ code: "EPIPE" })).toBe(true);
    expect(isPtyIoError({ code: "ENOENT" })).toBe(false);
    expect(isPtyIoError(new Error("boom"))).toBe(false);
  });
});
