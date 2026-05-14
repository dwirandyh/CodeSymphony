import {
  ChevronDown,
  ChevronUp,
  Search,
  X,
} from "lucide-react";
import type { ISearchOptions } from "@xterm/addon-search";
import {
  forwardRef,
  useDeferredValue,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { validateAttachmentSize } from "../../lib/attachments";
import { api } from "../../lib/api";
import { isTauriDesktop } from "../../lib/openExternalUrl";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  getOrCreateTerminalRuntime,
  type TerminalRuntime,
} from "./terminalRuntimeRegistry";
import "@xterm/xterm/css/xterm.css";

const DESKTOP_DOM_DROP_FALLBACK_DELAY_MS = 150;
const DESKTOP_NATIVE_DROP_SUPPRESSION_MS = 500;
const TERMINAL_TITLE_BRAILLE_PREFIX_PATTERN = /^([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])\s+(.*)$/u;
const TERMINAL_SEARCH_DECORATIONS: ISearchOptions["decorations"] = {
  matchBackground: "#1e293b",
  matchBorder: "#38bdf8",
  matchOverviewRuler: "#38bdf87a",
  activeMatchBackground: "#0f172a",
  activeMatchBorder: "#facc15",
  activeMatchColorOverviewRuler: "#facc15",
};

function buildTerminalSearchOptions(caseSensitive: boolean): ISearchOptions {
  return {
    caseSensitive,
    regex: false,
    decorations: TERMINAL_SEARCH_DECORATIONS,
  };
}

function getFallbackTerminalTitle(sessionId: string, cwd: string | null): string {
  const trimmedCwd = cwd?.trim();
  if (trimmedCwd) {
    const segments = trimmedCwd.split(/[\\/]/u).filter(Boolean);
    const leaf = segments[segments.length - 1];
    if (leaf) {
      return leaf;
    }
  }

  return sessionId.endsWith(":terminal") ? "Terminal" : "Terminal";
}

function splitTerminalTitleBraillePrefix(title: string): {
  braillePrefix: string | null;
  label: string;
} {
  const match = title.match(TERMINAL_TITLE_BRAILLE_PREFIX_PATTERN);
  if (!match) {
    return {
      braillePrefix: null,
      label: title,
    };
  }

  return {
    braillePrefix: match[1] ?? null,
    label: match[2] ?? title,
  };
}

function hasDroppableContent(dataTransfer: DataTransfer | null): boolean {
  const types = Array.from(dataTransfer?.types ?? []);
  return hasDraggedFiles(dataTransfer) || types.includes("text/plain") || types.includes("text/uri-list");
}

function hasDraggedFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) {
    return false;
  }

  const types = Array.from(dataTransfer.types ?? []);
  if (types.includes("Files")) {
    return true;
  }

  return Array.from(dataTransfer.items ?? []).some((item) => item.kind === "file");
}

function extractDraggedFiles(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) {
    return [];
  }

  const filesFromItems = Array.from(dataTransfer.items ?? [])
    .map((item) => item.getAsFile())
    .filter((file): file is File => file instanceof File);
  if (filesFromItems.length > 0) {
    return filesFromItems;
  }

  return Array.from(dataTransfer.files ?? []);
}

function resolveDroppedText(dataTransfer: DataTransfer | null): string | null {
  if (!dataTransfer) {
    return null;
  }

  const text = dataTransfer.getData("text/plain").trim();
  return text.length > 0 ? shellEscapePaths([text]) : null;
}

function escapePathForShell(path: string): string {
  if (path.length === 0) {
    return "''";
  }

  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(path)
    ? path
    : `'${path.replace(/'/g, "'\\''")}'`;
}

function shellEscapePaths(paths: string[]): string {
  return paths.map((path) => escapePathForShell(path)).join(" ");
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error(`Failed to read dropped file: ${file.name}`));
    };
    reader.readAsDataURL(file);
  });
}

interface TerminalTabProps {
  sessionId: string;
  cwd: string | null;
  onOpenFile?: (path: string) => void | Promise<void>;
  onSessionExit?: (event: { exitCode: number; signal: number }) => void;
  transformInput?: (data: string) => string;
}

export interface TerminalTabHandle {
  sendInput: (data: string) => void;
  focus: () => void;
}

export const TerminalTab = forwardRef<TerminalTabHandle, TerminalTabProps>(function TerminalTab({
  sessionId,
  cwd,
  onOpenFile,
  onSessionExit,
  transformInput,
}: TerminalTabProps, ref) {
  const rootRef = useRef<HTMLDivElement>(null);
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<TerminalRuntime | null>(null);
  const onSessionExitRef = useRef(onSessionExit);
  const onOpenFileRef = useRef(onOpenFile);
  const transformInputRef = useRef(transformInput);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [connected, setConnected] = useState(false);
  const [hasConnectedOnce, setHasConnectedOnce] = useState(false);
  const [terminalTitle, setTerminalTitle] = useState(() => getFallbackTerminalTitle(sessionId, cwd));
  const [isDragOver, setIsDragOver] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [searchHasMatch, setSearchHasMatch] = useState<boolean | null>(null);
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const dragDepthRef = useRef(0);
  const nativeDesktopDropListenerReadyRef = useRef(false);
  const lastNativeDesktopDropAtRef = useRef<number | null>(null);

  useEffect(() => {
    onSessionExitRef.current = onSessionExit;
  }, [onSessionExit]);

  useEffect(() => {
    onOpenFileRef.current = onOpenFile;
    runtimeRef.current?.setOpenFileHandler(onOpenFile ?? null);
  }, [onOpenFile]);

  useEffect(() => {
    transformInputRef.current = transformInput;
    runtimeRef.current?.setTransformInput(transformInput);
  }, [transformInput]);

  useImperativeHandle(ref, () => ({
    sendInput: (data: string) => {
      runtimeRef.current?.writeInput(data);
    },
    focus: () => {
      runtimeRef.current?.focus();
    },
  }), []);

  const openSearch = () => {
    setSearchOpen(true);
    focusSearchInput();
  };

  const closeSearch = () => {
    runtimeRef.current?.clearSearchDecorations();
    runtimeRef.current?.focus();
    setSearchOpen(false);
    setSearchQuery("");
    setSearchHasMatch(null);
  };

  const focusSearchInput = () => {
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  };

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || !searchOpen) {
      return;
    }

    const trimmedQuery = deferredSearchQuery.trim();
    if (trimmedQuery.length === 0) {
      runtime.clearSearchDecorations();
      setSearchHasMatch(null);
      return;
    }

    setSearchHasMatch(runtime.findNext(
      trimmedQuery,
      buildTerminalSearchOptions(searchCaseSensitive),
    ));
  }, [deferredSearchQuery, searchCaseSensitive, searchOpen]);

  const runSearch = (direction: "next" | "previous") => {
    const runtime = runtimeRef.current;
    const trimmedQuery = searchQuery.trim();
    if (!runtime || trimmedQuery.length === 0) {
      return;
    }

    const searchOptions = buildTerminalSearchOptions(searchCaseSensitive);
    setSearchHasMatch(direction === "previous"
      ? runtime.findPrevious(trimmedQuery, searchOptions)
      : runtime.findNext(trimmedQuery, searchOptions));
  };

  const showDropError = (message: string) => {
    runtimeRef.current?.writeLocalMessage(`Drop failed: ${message}`);
  };

  const pasteToTerminal = (text: string) => {
    if (text.length === 0) {
      return;
    }

    runtimeRef.current?.paste(text);
  };

  const pastePathsToTerminal = async (paths: string[]) => {
    const cleanedPaths = Array.from(
      new Set(paths.map((path) => path.trim()).filter((path) => path.length > 0)),
    );
    if (cleanedPaths.length === 0) {
      return;
    }

    pasteToTerminal(shellEscapePaths(cleanedPaths));
  };

  const pasteBrowserFilesToTerminal = async (files: File[]) => {
    try {
      const terminalDropFiles: Array<{
        filename: string;
        mimeType: string;
        contentBase64: string;
      }> = [];

      for (const file of files) {
        const sizeError = validateAttachmentSize(file);
        if (sizeError) {
          throw new Error(sizeError);
        }

        terminalDropFiles.push({
          filename: file.name || "attachment",
          mimeType: file.type || "application/octet-stream",
          contentBase64: await readFileAsBase64(file),
        });
      }

      const writtenFiles = await api.writeTerminalDropFiles(sessionId, terminalDropFiles);
      await pastePathsToTerminal(writtenFiles.map((file) => file.path));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to drop files into terminal";
      showDropError(message);
    }
  };

  useEffect(() => {
    if (!isTauriDesktop()) {
      return;
    }

    let active = true;
    let unlisten: null | (() => void) = null;

    void (async () => {
      try {
        const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        if (!active) {
          return;
        }

        nativeDesktopDropListenerReadyRef.current = true;
        unlisten = await getCurrentWebviewWindow().onDragDropEvent((event) => {
          const payload = event.payload as { type: string; paths?: string[] };

          if (payload.type === "over") {
            setIsDragOver(true);
            return;
          }

          dragDepthRef.current = 0;
          setIsDragOver(false);

          if (payload.type !== "drop") {
            return;
          }

          const paths = Array.isArray(payload.paths) ? payload.paths : [];
          if (paths.length === 0) {
            return;
          }

          lastNativeDesktopDropAtRef.current = Date.now();
          void pastePathsToTerminal(paths);
        });
      } catch {
        nativeDesktopDropListenerReadyRef.current = false;
      }
    })();

    return () => {
      active = false;
      nativeDesktopDropListenerReadyRef.current = false;
      lastNativeDesktopDropAtRef.current = null;
      unlisten?.();
    };
  }, []);

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasDroppableContent(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasDroppableContent(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setIsDragOver(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasDroppableContent(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }

    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragOver(false);
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasDroppableContent(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setIsDragOver(false);

    if (!connected) {
      return;
    }

    const files = extractDraggedFiles(event.dataTransfer);
    if (files.length === 0) {
      const droppedText = resolveDroppedText(event.dataTransfer);
      if (droppedText) {
        pasteToTerminal(droppedText);
      }
      return;
    }

    if (isTauriDesktop() && nativeDesktopDropListenerReadyRef.current) {
      window.setTimeout(() => {
        const lastNativeDropAt = lastNativeDesktopDropAtRef.current;
        if (lastNativeDropAt !== null && Date.now() - lastNativeDropAt < DESKTOP_NATIVE_DROP_SUPPRESSION_MS) {
          return;
        }

        void pasteBrowserFilesToTerminal(files);
      }, DESKTOP_DOM_DROP_FALLBACK_DELAY_MS);
      return;
    }

    void pasteBrowserFilesToTerminal(files);
  };

  useEffect(() => {
    const container = terminalContainerRef.current;
    if (!container) {
      return;
    }

    const runtime = getOrCreateTerminalRuntime(sessionId, cwd, container);
    runtimeRef.current = runtime;
    runtime.setTransformInput(transformInputRef.current);
    runtime.setOpenFileHandler(onOpenFileRef.current ?? null);
    runtime.attach(container);
    runtime.scheduleFitBurst();

    setConnected(runtime.connected);
    setHasConnectedOnce(runtime.connected);
    setTerminalTitle(runtime.title);
    const disconnectConnectionListener = runtime.onConnectionStateChange((isConnected) => {
      setConnected(isConnected);
      if (isConnected) {
        setHasConnectedOnce(true);
      }
    });
    const disconnectTitleListener = runtime.onTitleChange(setTerminalTitle);
    const disconnectSessionExitListener = runtime.onSessionExit((event) => {
      onSessionExitRef.current?.(event);
    });

    const resizeObserver = new ResizeObserver(() => {
      runtime.scheduleFitBurst();
    });
    resizeObserver.observe(container);

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        runtime.scheduleFitBurst();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    void document.fonts?.ready?.then(() => {
      runtime.scheduleFitBurst();
    });

    return () => {
      disconnectConnectionListener();
      disconnectTitleListener();
      disconnectSessionExitListener();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      resizeObserver.disconnect();
      runtime.setTransformInput(undefined);
      runtime.setOpenFileHandler(null);
      runtime.detach();
      if (runtimeRef.current === runtime) {
        runtimeRef.current = null;
      }
    };
  }, [cwd, sessionId]);

  const connectionLabel = connected ? "Connected" : hasConnectedOnce ? "Reconnecting" : "Connecting";
  const connectionIndicatorClassName = connected
    ? "bg-emerald-300"
    : hasConnectedOnce
      ? "bg-amber-300"
      : "bg-slate-300";
  const terminalTitleParts = splitTerminalTitleBraillePrefix(terminalTitle);

  return (
    <div
      ref={rootRef}
      className="relative flex h-full min-w-0 flex-1 flex-col bg-[#0f1218]"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onKeyDownCapture={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
          event.preventDefault();
          event.stopPropagation();
          openSearch();
          return;
        }

        if (event.key === "Escape" && searchOpen) {
          event.preventDefault();
          event.stopPropagation();
          closeSearch();
        }
      }}
    >
      <div className="relative z-20 border-b border-white/8 bg-[#141922]/95 px-3 py-2 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0 flex-1">
            <span
              className="block truncate text-sm font-medium tracking-[0.01em] text-white/90"
              aria-label={terminalTitle}
            >
              {terminalTitleParts.braillePrefix ? (
                <>
                  <span
                    aria-hidden="true"
                    data-testid="terminal-title-braille-prefix"
                    className="text-primary"
                  >
                    {terminalTitleParts.braillePrefix}
                  </span>
                  {" "}
                  {terminalTitleParts.label}
                </>
              ) : terminalTitle}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span
              role="status"
              aria-label={connectionLabel}
              title={connectionLabel}
              data-testid="terminal-connection-indicator"
              className={cn(
                "inline-block h-2.5 w-2.5 rounded-full",
                connectionIndicatorClassName,
              )}
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className={cn(
                "h-8 w-8 shrink-0 rounded-md text-white/60 hover:bg-white/8 hover:text-white",
                searchOpen && "bg-white/10 text-white",
              )}
              onClick={openSearch}
              aria-label="Search terminal output"
              title="Search terminal output (Cmd/Ctrl+F)"
            >
              <Search className="h-4 w-4" />
            </Button>
          </div>
        </div>
        {searchOpen ? (
          <div className="absolute right-2 top-full z-30 mt-2 flex max-w-[calc(100vw-3rem)] items-center gap-2 rounded-[18px] border border-white/10 bg-[#06080d]/95 p-1.5 shadow-[0_18px_40px_rgba(0,0,0,0.45)] backdrop-blur-md">
            <Input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  runSearch(event.shiftKey ? "previous" : "next");
                  return;
                }

                if (event.key === "Escape") {
                  event.preventDefault();
                  closeSearch();
                }
              }}
              placeholder="Find"
              className={cn(
                "h-10 w-56 max-w-[calc(100vw-14rem)] rounded-[14px] border border-sky-400/20 bg-black px-3 text-sm text-white placeholder:text-white/45 focus-visible:border-sky-400/50 focus-visible:ring-0 sm:w-72",
                searchHasMatch === false && "border-amber-400/40 text-amber-300 placeholder:text-amber-300/45",
              )}
            />
            {searchHasMatch === false && searchQuery.trim().length > 0 ? (
              <span className="shrink-0 text-xs text-amber-300">No results</span>
            ) : null}
            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className={cn(
                  "h-8 w-8 rounded-md text-white/70 hover:bg-white/10 hover:text-white",
                  searchCaseSensitive && "bg-white/12 text-white",
                )}
                onClick={() => setSearchCaseSensitive((current) => !current)}
                aria-label="Match case"
                aria-pressed={searchCaseSensitive}
                title="Match case"
              >
                <span className="text-sm font-medium leading-none">Aa</span>
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-8 w-8 rounded-md text-white/70 hover:bg-white/10 hover:text-white"
                onClick={() => runSearch("previous")}
                aria-label="Find previous terminal match"
                title="Previous match (Shift+Enter)"
              >
                <ChevronUp className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-8 w-8 rounded-md text-white/70 hover:bg-white/10 hover:text-white"
                onClick={() => runSearch("next")}
                aria-label="Find next terminal match"
                title="Next match (Enter)"
              >
                <ChevronDown className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-8 w-8 rounded-md text-white/70 hover:bg-white/10 hover:text-white"
                onClick={closeSearch}
                aria-label="Close terminal search"
                title="Close terminal search (Esc)"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ) : null}
      </div>
      <div
        ref={terminalContainerRef}
        className="terminal-scrollbars-thin min-h-0 min-w-0 flex-1 overflow-hidden bg-[#0f1218]"
      />
      <div
        className={cn(
          "pointer-events-none absolute inset-0 bg-sky-400/10 ring-1 ring-inset ring-sky-400/30 transition-opacity duration-100",
          isDragOver ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
});
