import { describe, expect, it } from "vitest";
import { parseUserMentions, serializeMention, serializeMentionPrefix, MENTION_TOKEN_REGEX, COMMAND_TOKEN_REGEX } from "./mentions";

describe("MENTION_TOKEN_REGEX", () => {
  it("matches file mention", () => {
    const match = "@file:src/index.ts".match(new RegExp(MENTION_TOKEN_REGEX.source));
    expect(match).toBeTruthy();
  });

  it("matches dir mention", () => {
    const match = "@dir:src/utils".match(new RegExp(MENTION_TOKEN_REGEX.source));
    expect(match).toBeTruthy();
  });

  it("does not match invalid mention", () => {
    const match = "@invalid:path".match(new RegExp(MENTION_TOKEN_REGEX.source));
    expect(match).toBeNull();
  });
});

describe("COMMAND_TOKEN_REGEX", () => {
  it("matches slash command", () => {
    const match = "/commit".match(new RegExp(COMMAND_TOKEN_REGEX.source));
    expect(match).toBeTruthy();
  });
});

describe("parseUserMentions", () => {
  it("returns single text segment for no mentions", () => {
    const result = parseUserMentions("hello world");
    expect(result).toEqual([{ kind: "text", value: "hello world" }]);
  });

  it("parses single file mention", () => {
    const result = parseUserMentions("look at @file:src/index.ts please");
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ kind: "text", value: "look at " });
    expect(result[1]).toEqual({
      kind: "mention",
      path: "src/index.ts",
      name: "index.ts",
      isDirectory: false,
    });
    expect(result[2]).toEqual({ kind: "text", value: " please" });
  });

  it("parses directory mention", () => {
    const result = parseUserMentions("@dir:src/utils");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "mention",
      path: "src/utils",
      name: "utils",
      isDirectory: true,
    });
  });

  it("parses multiple mentions", () => {
    const result = parseUserMentions("@file:a.ts and @dir:src/b");
    expect(result).toHaveLength(3);
    expect(result[0].kind).toBe("mention");
    expect(result[1]).toEqual({ kind: "text", value: " and " });
    expect(result[2].kind).toBe("mention");
  });

  it("parses slash command segments", () => {
    const result = parseUserMentions("run /commit then inspect @file:src/index.ts");
    expect(result).toEqual([
      { kind: "text", value: "run " },
      { kind: "command", name: "commit" },
      { kind: "text", value: " then inspect " },
      {
        kind: "mention",
        path: "src/index.ts",
        name: "index.ts",
        isDirectory: false,
      },
    ]);
  });

  it("returns empty array elements for empty string", () => {
    const result = parseUserMentions("");
    expect(result).toHaveLength(0);
  });
});

describe("serializeMention", () => {
  it("serializes file mention", () => {
    expect(serializeMention("src/index.ts", "file")).toBe("@file:src/index.ts");
  });

  it("serializes directory mention", () => {
    expect(serializeMention("src/utils", "directory")).toBe("@dir:src/utils");
  });
});

describe("serializeMentionPrefix", () => {
  it("returns empty string for no files", () => {
    expect(serializeMentionPrefix([])).toBe("");
  });

  it("serializes single file", () => {
    expect(serializeMentionPrefix([{ path: "a.ts", type: "file" }])).toBe("@file:a.ts");
  });

  it("serializes multiple files with space separator", () => {
    const result = serializeMentionPrefix([
      { path: "a.ts", type: "file" },
      { path: "src", type: "directory" },
    ]);
    expect(result).toBe("@file:a.ts @dir:src");
  });
});
