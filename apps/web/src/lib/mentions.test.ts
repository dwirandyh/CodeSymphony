import { describe, expect, it } from "vitest";
import {
  MENTION_TOKEN_REGEX,
  parseUserMentions,
  serializeMention,
  serializeMentionPrefix,
} from "./mentions";

describe("serializeMention", () => {
  it("serializes a file mention", () => {
    expect(serializeMention("src/index.ts", "file")).toBe("@file:src/index.ts");
  });

  it("serializes a directory mention", () => {
    expect(serializeMention("src/utils", "directory")).toBe("@dir:src/utils");
  });
});

describe("serializeMentionPrefix", () => {
  it("joins multiple mentions with spaces", () => {
    const result = serializeMentionPrefix([
      { path: "src/a.ts", type: "file" },
      { path: "src/lib", type: "directory" },
    ]);
    expect(result).toBe("@file:src/a.ts @dir:src/lib");
  });

  it("returns empty string for no mentions", () => {
    expect(serializeMentionPrefix([])).toBe("");
  });
});

describe("parseUserMentions", () => {
  it("returns plain text as a single text segment", () => {
    const result = parseUserMentions("hello world");
    expect(result).toEqual([{ kind: "text", value: "hello world" }]);
  });

  it("parses a file mention token", () => {
    const result = parseUserMentions("@file:src/index.ts");
    expect(result).toEqual([
      { kind: "mention", path: "src/index.ts", name: "index.ts", isDirectory: false },
    ]);
  });

  it("parses a directory mention token", () => {
    const result = parseUserMentions("@dir:src/utils");
    expect(result).toEqual([
      { kind: "mention", path: "src/utils", name: "utils", isDirectory: true },
    ]);
  });

  it("parses mixed text and mentions", () => {
    const input = "@file:src/a.ts @dir:src/lib\nPlease review these files";
    const result = parseUserMentions(input);
    expect(result).toEqual([
      { kind: "mention", path: "src/a.ts", name: "a.ts", isDirectory: false },
      { kind: "text", value: " " },
      { kind: "mention", path: "src/lib", name: "lib", isDirectory: true },
      { kind: "text", value: "\nPlease review these files" },
    ]);
  });

  it("handles paths with dots and dashes", () => {
    const result = parseUserMentions("@file:src/my-component.test.tsx");
    expect(result).toEqual([
      { kind: "mention", path: "src/my-component.test.tsx", name: "my-component.test.tsx", isDirectory: false },
    ]);
  });

  it("does not match incomplete mention tokens", () => {
    const result = parseUserMentions("@file: is not a valid mention");
    expect(result).toEqual([{ kind: "text", value: "@file: is not a valid mention" }]);
  });
});

describe("round-trip: serialize then parse", () => {
  it("round-trips a file mention", () => {
    const serialized = serializeMention("src/index.ts", "file");
    const parsed = parseUserMentions(serialized);
    expect(parsed).toEqual([
      { kind: "mention", path: "src/index.ts", name: "index.ts", isDirectory: false },
    ]);
  });

  it("round-trips a directory mention", () => {
    const serialized = serializeMention("src/utils", "directory");
    const parsed = parseUserMentions(serialized);
    expect(parsed).toEqual([
      { kind: "mention", path: "src/utils", name: "utils", isDirectory: true },
    ]);
  });

  it("round-trips a full message with prefix + text", () => {
    const prefix = serializeMentionPrefix([
      { path: "src/a.ts", type: "file" },
      { path: "src/lib", type: "directory" },
    ]);
    const message = `${prefix}\nFix these files please`;
    const parsed = parseUserMentions(message);

    expect(parsed).toEqual([
      { kind: "mention", path: "src/a.ts", name: "a.ts", isDirectory: false },
      { kind: "text", value: " " },
      { kind: "mention", path: "src/lib", name: "lib", isDirectory: true },
      { kind: "text", value: "\nFix these files please" },
    ]);
  });
});

describe("MENTION_TOKEN_REGEX", () => {
  it("matches valid file tokens", () => {
    const regex = new RegExp(MENTION_TOKEN_REGEX.source, MENTION_TOKEN_REGEX.flags);
    const match = regex.exec("@file:src/index.ts");
    expect(match).not.toBeNull();
    expect(match![1]).toBe("file");
    expect(match![2]).toBe("src/index.ts");
  });

  it("matches valid dir tokens", () => {
    const regex = new RegExp(MENTION_TOKEN_REGEX.source, MENTION_TOKEN_REGEX.flags);
    const match = regex.exec("@dir:src/utils");
    expect(match).not.toBeNull();
    expect(match![1]).toBe("dir");
    expect(match![2]).toBe("src/utils");
  });

  it("does not match @unknown: prefix", () => {
    const regex = new RegExp(MENTION_TOKEN_REGEX.source, MENTION_TOKEN_REGEX.flags);
    const match = regex.exec("@unknown:src/index.ts");
    expect(match).toBeNull();
  });
});
