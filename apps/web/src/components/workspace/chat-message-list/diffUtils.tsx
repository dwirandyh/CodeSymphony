import { memo, useMemo } from "react";
import { Copy } from "lucide-react";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";

const DIFF_HEADER_REGEX = /^(diff --git .+|--- [^\r\n]+|\+\+\+ [^\r\n]+|@@ .+ @@)/m;
const CODE_FENCE_REGEX = /(^|\n)```/g;
const CLOSE_FENCE_REGEX = /^`{3,}$/;
const TRUNCATED_DIFF_MARKER = "... [diff truncated]";
const TRUNCATED_DIFF_TRAILER_REGEX = /(?:\r?\n){1,2}\.\.\. \[diff truncated\]\s*$/;

export function normalizePatchForRender(patch: string): {
  patch: string;
  diffTruncated: boolean;
} {
  const diffTruncated = TRUNCATED_DIFF_TRAILER_REGEX.test(patch);
  if (!diffTruncated) {
    return { patch, diffTruncated: false };
  }

  return {
    patch: patch.replace(TRUNCATED_DIFF_TRAILER_REGEX, "").replace(/(?:\r?\n)+$/, ""),
    diffTruncated: true,
  };
}

export function isLikelyDiff(code: string, language?: string): boolean {
  if (language === "diff") {
    return true;
  }

  return DIFF_HEADER_REGEX.test(code);
}

export const SafePatchDiff = memo(function SafePatchDiff({
  patch,
  options,
}: {
  patch: string;
  options: React.ComponentProps<typeof FileDiff>["options"];
}) {
  const { patch: normalizedPatch, diffTruncated } = useMemo(() => normalizePatchForRender(patch), [patch]);
  const files = useMemo(() => {
    if (normalizedPatch.trim().length === 0) {
      return [];
    }

    try {
      return parsePatchFiles(normalizedPatch).flatMap((p) => p.files);
    } catch {
      return null;
    }
  }, [normalizedPatch]);

  if (!files || files.length === 0) {
    return (
      <>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
          {normalizedPatch}
        </pre>
        {diffTruncated ? (
          <div className="px-3 pt-1.5 pb-2 text-[11px] text-muted-foreground">{TRUNCATED_DIFF_MARKER}</div>
        ) : null}
      </>
    );
  }

  return (
    <>
      {files.map((file, index) => (
        <FileDiff key={`${file.name}:${index}`} fileDiff={file} options={options} />
      ))}
      {diffTruncated ? (
        <div className="px-3 pt-1.5 pb-2 text-[11px] text-muted-foreground">{TRUNCATED_DIFF_MARKER}</div>
      ) : null}
    </>
  );
});

export function hasUnclosedCodeFence(content: string): boolean {
  CODE_FENCE_REGEX.lastIndex = 0;
  const fenceCount = (content.match(CODE_FENCE_REGEX) ?? []).length;
  return fenceCount % 2 !== 0;
}

function splitRawFileContentWithMode(
  content: string,
  requireClosingFence: boolean,
): {
  lead: string;
  code: string;
  tail: string;
  language?: string;
} | null {
  const fenceStart = content.indexOf("```");
  if (fenceStart < 0) {
    return null;
  }

  const openFenceLineEnd = content.indexOf("\n", fenceStart + 3);
  if (openFenceLineEnd < 0) {
    return null;
  }

  const openFenceLine = content.slice(fenceStart + 3, openFenceLineEnd).trim();
  if (!requireClosingFence) {
    return {
      lead: content.slice(0, fenceStart).trim(),
      code: content.slice(openFenceLineEnd + 1),
      tail: "",
      language: openFenceLine.length > 0 ? openFenceLine : undefined,
    };
  }

  const closeFenceLineStart = content.lastIndexOf("\n```");
  if (closeFenceLineStart <= openFenceLineEnd) {
    return {
      lead: content.slice(0, fenceStart).trim(),
      code: content.slice(openFenceLineEnd + 1),
      tail: "",
      language: openFenceLine.length > 0 ? openFenceLine : undefined,
    };
  }

  const closeFenceLineEndRaw = content.indexOf("\n", closeFenceLineStart + 1);
  const closeFenceLineEnd = closeFenceLineEndRaw < 0 ? content.length : closeFenceLineEndRaw;
  const closeFenceLine = content.slice(closeFenceLineStart + 1, closeFenceLineEnd).trim();
  if (!CLOSE_FENCE_REGEX.test(closeFenceLine)) {
    return {
      lead: content.slice(0, fenceStart).trim(),
      code: content.slice(openFenceLineEnd + 1),
      tail: "",
      language: openFenceLine.length > 0 ? openFenceLine : undefined,
    };
  }

  const lead = content.slice(0, fenceStart).trim();
  const code = content.slice(openFenceLineEnd + 1, closeFenceLineStart).replace(/\n$/, "");
  const tail = content.slice(closeFenceLineEnd).trim();

  return {
    lead,
    code,
    tail,
    language: openFenceLine.length > 0 ? openFenceLine : undefined,
  };
}

export function RawFileBlock({
  content,
  mode,
  language,
  splitNarrative,
  streaming,
}: {
  content: string;
  mode: "raw-file" | "raw-fallback";
  language?: string;
  splitNarrative?: boolean;
  streaming?: boolean;
}) {
  const parsed =
    mode === "raw-file" && splitNarrative !== false
      ? splitRawFileContentWithMode(content, !streaming)
      : null;
  const code = parsed?.code ?? content;
  const headerLanguage =
    mode === "raw-file"
      ? (language?.trim().toLowerCase() || parsed?.language?.trim().toLowerCase() || "text")
      : "text";
  const lead = parsed?.lead ?? "";
  const tail = parsed?.tail ?? "";

  return (
    <div className="space-y-2" data-testid={`assistant-render-${mode}`}>
      {lead.length > 0 ? <p className="whitespace-pre-wrap break-words leading-relaxed">{lead}</p> : null}
      <div className="overflow-hidden rounded-2xl border border-border/35 bg-secondary/20 transition-[border-color,background-color] duration-200">
        <div className="flex items-center justify-between border-b border-border/35 px-3 py-2 text-xs text-muted-foreground">
          <span className="font-semibold lowercase tracking-wide">{headerLanguage}</span>
          <button
            type="button"
            aria-label="Copy file output"
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => {
              if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") {
                return;
              }
              void navigator.clipboard.writeText(code);
            }}
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-sm leading-relaxed text-foreground">
          {code}
        </pre>
      </div>
      {tail.length > 0 ? <p className="whitespace-pre-wrap break-words leading-relaxed">{tail}</p> : null}
    </div>
  );
}
