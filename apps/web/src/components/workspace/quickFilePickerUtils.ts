import fuzzysort from "fuzzysort";
import type { FileEntry } from "@codesymphony/shared-types";

export type QuickFileItem = {
  path: string;
  name: string;
  directory: string;
};

function toQuickFileItem(entry: FileEntry): QuickFileItem {
  const parts = entry.path.split("/");
  const name = parts[parts.length - 1] ?? entry.path;
  return {
    path: entry.path,
    name,
    directory: parts.slice(0, -1).join("/"),
  };
}

export function buildQuickFileItems(entries: FileEntry[]) {
  return entries
    .filter((entry) => entry.type === "file")
    .map(toQuickFileItem)
    .sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: "base" }));
}

export function filterQuickFileItems(items: QuickFileItem[], rawQuery: string) {
  const query = rawQuery.trim();

  if (!query) {
    return items.slice(0, 100);
  }

  return fuzzysort.go(query, items, {
    keys: ["name", "path", "directory"],
    limit: 100,
    threshold: -10_000,
  }).map((result) => result.obj);
}
