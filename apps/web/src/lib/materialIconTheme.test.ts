import { describe, expect, it } from "vitest";
import type { MaterialIconThemeManifest } from "./materialIconTheme";
import { resolveMaterialIconThemeIconFile } from "./materialIconTheme";

const manifest: MaterialIconThemeManifest = {
  iconDefinitions: {
    file: { iconPath: "./../icons/file.svg" },
    folder: { iconPath: "./../icons/folder.svg" },
    "folder-open": { iconPath: "./../icons/folder-open.svg" },
    "folder-src": { iconPath: "./../icons/folder-src.svg" },
    "folder-src-open": { iconPath: "./../icons/folder-src-open.svg" },
    markdown: { iconPath: "./../icons/markdown.svg" },
    typescript: { iconPath: "./../icons/typescript.svg" },
    lock: { iconPath: "./../icons/lock.svg" },
  },
  file: "file",
  folder: "folder",
  folderExpanded: "folder-open",
  rootFolder: "folder",
  rootFolderExpanded: "folder-open",
  fileNames: {
    "pnpm-lock.yaml": "lock",
    "config/readme": "markdown",
  },
  fileExtensions: {
    "d.ts": "typescript",
    md: "markdown",
    ts: "typescript",
  },
  folderNames: {
    src: "folder-src",
  },
  folderNamesExpanded: {
    src: "folder-src-open",
  },
  rootFolderNames: {},
  rootFolderNamesExpanded: {},
};

describe("resolveMaterialIconThemeIconFile", () => {
  it("resolves folder icons by folder name and expansion state", () => {
    expect(resolveMaterialIconThemeIconFile(manifest, {
      path: "src",
      type: "directory",
      isExpanded: false,
      isRoot: true,
    })).toBe("folder-src.svg");

    expect(resolveMaterialIconThemeIconFile(manifest, {
      path: "src",
      type: "directory",
      isExpanded: true,
      isRoot: true,
    })).toBe("folder-src-open.svg");
  });

  it("prefers exact file-name matches over extension matches", () => {
    expect(resolveMaterialIconThemeIconFile(manifest, {
      path: "pnpm-lock.yaml",
      type: "file",
    })).toBe("lock.svg");
  });

  it("supports nested file-name associations and compound extensions", () => {
    expect(resolveMaterialIconThemeIconFile(manifest, {
      path: "config/README",
      type: "file",
    })).toBe("markdown.svg");

    expect(resolveMaterialIconThemeIconFile(manifest, {
      path: "src/env.d.ts",
      type: "file",
    })).toBe("typescript.svg");
  });

  it("falls back to default file and folder icons", () => {
    expect(resolveMaterialIconThemeIconFile(manifest, {
      path: "notes.txt",
      type: "file",
    })).toBe("file.svg");

    expect(resolveMaterialIconThemeIconFile(manifest, {
      path: "misc",
      type: "directory",
      isExpanded: false,
    })).toBe("folder.svg");
  });
});
