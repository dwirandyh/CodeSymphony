import { describe, expect, it } from "vitest";
import { __testing } from "../src/claude/sessionRunner";

describe("extractBashToolResult", () => {
  it("extracts stdout and stderr payloads", () => {
    const result = __testing.extractBashToolResult({
      stdout: "/tmp/project",
      stderr: "",
      interrupted: false,
    });

    expect(result).not.toBeNull();
    expect(result?.output).toBe("/tmp/project");
    expect(result?.error).toBeUndefined();
    expect(result?.truncated).toBe(false);
  });

  it("treats string tool response as output", () => {
    const result = __testing.extractBashToolResult("/tmp/project");

    expect(result).not.toBeNull();
    expect(result?.output).toBe("/tmp/project");
    expect(result?.error).toBeUndefined();
  });

  it("treats error-prefixed string as error output", () => {
    const result = __testing.extractBashToolResult("Error: Exit code 1");

    expect(result).not.toBeNull();
    expect(result?.output).toBeUndefined();
    expect(result?.error).toBe("Error: Exit code 1");
  });

  it("extracts text content payloads", () => {
    const result = __testing.extractBashToolResult({
      is_error: false,
      content: [
        {
          type: "text",
          text: "/Users/demo/project",
        },
      ],
    });

    expect(result).not.toBeNull();
    expect(result?.output).toBe("/Users/demo/project");
    expect(result?.error).toBeUndefined();
  });
});
