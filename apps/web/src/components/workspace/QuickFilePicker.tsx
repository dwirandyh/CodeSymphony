import type { RefObject } from "react";
import { FileCode2, Search } from "lucide-react";
import { Input } from "../ui/input";
import { cn } from "../../lib/utils";
import type { QuickFileItem } from "./quickFilePickerUtils";

export function QuickFilePicker({
  open,
  query,
  items,
  loading,
  selectedIndex,
  inputRef,
  shortcutLabel,
  onQueryChange,
  onSelectedIndexChange,
  onSelect,
  onClose,
}: {
  open: boolean;
  query: string;
  items: QuickFileItem[];
  loading: boolean;
  selectedIndex: number;
  inputRef: RefObject<HTMLInputElement | null>;
  shortcutLabel: string;
  onQueryChange: (value: string) => void;
  onSelectedIndexChange: (index: number) => void;
  onSelect: (item: QuickFileItem) => void;
  onClose: () => void;
}) {
  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/35 px-4 pt-[10vh] backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="w-full max-w-[720px] overflow-hidden rounded-xl border border-border/70 bg-popover/95 shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search files in current worktree"
            aria-label="Search files in current worktree"
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="h-8 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                if (items.length > 0) {
                  onSelectedIndexChange((selectedIndex + 1) % items.length);
                }
                return;
              }

              if (event.key === "ArrowUp") {
                event.preventDefault();
                if (items.length > 0) {
                  onSelectedIndexChange((selectedIndex - 1 + items.length) % items.length);
                }
                return;
              }

              if (event.key === "Enter") {
                event.preventDefault();
                const selectedItem = items[selectedIndex] ?? null;
                if (selectedItem) {
                  onSelect(selectedItem);
                }
                return;
              }

              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
          />
          <div className="shrink-0 text-[11px] text-muted-foreground">{shortcutLabel}</div>
        </div>

        <div className="max-h-[420px] overflow-y-auto py-1" data-testid="quick-file-picker">
          {loading ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">Indexing files...</div>
          ) : items.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">No matching files.</div>
          ) : (
            items.map((item, index) => {
              const selected = index === selectedIndex;

              return (
                <button
                  key={item.path}
                  type="button"
                  className={cn(
                    "flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left transition-colors",
                    selected ? "bg-secondary/70 text-foreground" : "text-foreground/90 hover:bg-secondary/45",
                  )}
                  onClick={() => onSelect(item)}
                  onMouseEnter={() => onSelectedIndexChange(index)}
                >
                  <FileCode2 className="h-4 w-4 shrink-0 text-primary/80" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{item.name}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{item.directory || "."}</div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
