import { memo, useMemo, type ComponentProps, type ComponentType } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { openExternalUrl, shouldOpenInExternalApp } from "../../../lib/openExternalUrl";
import { parseFileLocation, serializeFileLocation, toWorktreeRelativePath } from "../../../lib/worktree";
import type { AssistantRenderHint } from "./ChatMessageList.types";
import { isLikelyDiff, SafePatchDiff, hasUnclosedCodeFence, RawFileBlock } from "./diffUtils";

const TRAILING_INCOMPLETE_MARKDOWN_LINK_PATTERNS = [
  /(^|[\s(])\[([^\]\n]*)\]\(([^)\n]*)$/u,
  /(^|[\s(])\[([^\]\n]*)\]$/u,
  /(^|[\s(])\[([^\]\n]*)$/u,
];

function collapseTrailingIncompleteMarkdownLink(content: string): string {
  for (const pattern of TRAILING_INCOMPLETE_MARKDOWN_LINK_PATTERNS) {
    const match = pattern.exec(content);
    if (!match) {
      continue;
    }

    const [matchedText, prefix = "", label = ""] = match;
    if (matchedText.length === 0) {
      return content;
    }

    return `${content.slice(0, match.index)}${prefix}${label}`;
  }

  return content;
}

function parseLinkUrl(href: string): URL | null {
  try {
    const baseHref = typeof window === "undefined" ? "http://localhost" : window.location.href;
    return new URL(href, baseHref);
  } catch {
    return null;
  }
}

function safeDecodePath(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

function isLikelyAbsoluteFsPath(input: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(input)
    || input.startsWith("/Users/")
    || input.startsWith("/home/")
    || input.startsWith("/private/")
    || input.startsWith("/var/");
}

type InternalWorktreeFileTarget = {
  path: string;
  line: number | null;
  column: number | null;
};

function resolveInternalWorktreeFileTarget(
  href: string,
  worktreePath: string | null | undefined,
): InternalWorktreeFileTarget | null {
  if (!worktreePath) {
    return null;
  }

  const trimmedHref = href.trim();
  if (trimmedHref.length === 0) {
    return null;
  }

  if (/^[A-Za-z]:[\\/]/u.test(trimmedHref)) {
    const location = parseFileLocation(safeDecodePath(trimmedHref));
    const relativePath = toWorktreeRelativePath(worktreePath, location.path);
    if (relativePath && relativePath.length > 0) {
      return { path: relativePath, line: location.line, column: location.column };
    }

    return { path: location.path, line: location.line, column: location.column };
  }

  const url = parseLinkUrl(trimmedHref);
  if (!url) {
    return null;
  }

  if (url.protocol === "mailto:" || url.protocol === "tel:") {
    return null;
  }

  if (
    typeof window !== "undefined"
    && (url.protocol === "http:" || url.protocol === "https:")
    && url.origin !== window.location.origin
  ) {
    return null;
  }

  const location = parseFileLocation(safeDecodePath(`${url.pathname}${url.hash}`));
  const relativePath = toWorktreeRelativePath(worktreePath, location.path);
  if (relativePath && relativePath.length > 0) {
    return { path: relativePath, line: location.line, column: location.column };
  }

  if (isLikelyAbsoluteFsPath(location.path)) {
    return { path: location.path, line: location.line, column: location.column };
  }

  return null;
}

type MarkdownRenderer<Tag extends keyof Components> = Extract<NonNullable<Components[Tag]>, ComponentType<any>>;

function createMarkdownRenderer<Tag extends keyof Components>(
  renderer: MarkdownRenderer<Tag>,
): MarkdownRenderer<Tag> {
  return renderer;
}

function MarkdownLink({
  children,
  href,
  onOpenFilePath,
  worktreePath,
}: ComponentProps<"a"> & {
  node?: unknown;
  onOpenFilePath?: (path: string) => void | Promise<void>;
  worktreePath?: string | null;
}) {
  const opensExternally = typeof href === "string" && shouldOpenInExternalApp(href);
  const internalFilePath = typeof href === "string"
    ? resolveInternalWorktreeFileTarget(href, worktreePath)
    : null;

  return (
    <a
      href={href}
      className="font-medium text-primary underline underline-offset-4 hover:text-primary/80"
      target={opensExternally ? "_blank" : undefined}
      rel={opensExternally ? "noreferrer" : undefined}
      onClick={(event) => {
        if (internalFilePath && onOpenFilePath) {
          event.preventDefault();
          void onOpenFilePath(serializeFileLocation(
            internalFilePath.path,
            internalFilePath.line,
            internalFilePath.column,
          ));
          return;
        }

        if (!href || !opensExternally) {
          return;
        }

        event.preventDefault();
        void openExternalUrl(href);
      }}
    >
      {children}
    </a>
  );
}

const BASE_MARKDOWN_COMPONENTS = {
  p: createMarkdownRenderer<"p">(({ children }) => <p className="leading-6 [&:not(:first-child)]:mt-4 whitespace-pre-wrap break-words">{children}</p>),
  ul: createMarkdownRenderer<"ul">(({ children }) => <ul className="my-4 ml-6 list-disc [&>li]:mt-1.5">{children}</ul>),
  ol: createMarkdownRenderer<"ol">(({ children, start }) => (
    <ol start={start} className="my-4 ml-6 list-decimal [&>li]:mt-1.5">
      {children}
    </ol>
  )),
  li: createMarkdownRenderer<"li">(({ children }) => <li>{children}</li>),
  h1: createMarkdownRenderer<"h1">(({ children }) => <h1 className="scroll-m-16 text-xl font-bold tracking-tight mb-3">{children}</h1>),
  h2: createMarkdownRenderer<"h2">(({ children }) => <h2 className="scroll-m-16 border-b pb-1.5 text-lg font-semibold tracking-tight mt-5 mb-3 first:mt-0">{children}</h2>),
  h3: createMarkdownRenderer<"h3">(({ children }) => <h3 className="scroll-m-16 text-base font-semibold tracking-tight mt-4 mb-2">{children}</h3>),
  h4: createMarkdownRenderer<"h4">(({ children }) => <h4 className="scroll-m-16 text-sm font-semibold tracking-tight mt-3 mb-1.5">{children}</h4>),
  blockquote: createMarkdownRenderer<"blockquote">(({ children }) => (
    <blockquote className="mt-4 border-l-2 border-primary pl-4 italic text-muted-foreground">{children}</blockquote>
  )),
  table: createMarkdownRenderer<"table">(({ children }) => (
    <div className="my-4 w-full overflow-x-auto text-sm">
      <table className="w-full border-collapse">{children}</table>
    </div>
  )),
  thead: createMarkdownRenderer<"thead">(({ children }) => <thead className="border-b">{children}</thead>),
  tbody: createMarkdownRenderer<"tbody">(({ children }) => <tbody>{children}</tbody>),
  tr: createMarkdownRenderer<"tr">(({ children }) => <tr className="m-0 border-t p-0 even:bg-muted/50">{children}</tr>),
  th: createMarkdownRenderer<"th">(({ children }) => <th className="border px-3 py-1.5 text-left font-bold [&[align=center]]:text-center [&[align=right]]:text-right">{children}</th>),
  td: createMarkdownRenderer<"td">(({ children }) => <td className="border px-3 py-1.5 text-left [&[align=center]]:text-center [&[align=right]]:text-right">{children}</td>),
  strong: createMarkdownRenderer<"strong">(({ children }) => <strong className="font-semibold">{children}</strong>),
  code: createMarkdownRenderer<"code">(({ className, children }) => {
    const language = className?.replace("language-", "").trim();
    const text = String(children).replace(/\n$/, "");
    const inline = !className && !text.includes("\n");

    if (inline) {
      return <code className="relative rounded bg-muted px-[0.25rem] py-[0.15rem] font-mono text-xs font-semibold break-all">{text}</code>;
    }

    if (isLikelyDiff(text, language)) {
      return (
        <div className="my-3 rounded-md border border-border/40 bg-secondary/20 p-2.5 last:mb-0">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            Diff
          </div>
          <SafePatchDiff
            patch={text}
            options={{
              diffStyle: "unified",
              overflow: "wrap",
              theme: "pierre-dark",
              themeType: "dark",
              expandUnchanged: false,
              expansionLineCount: 20,
            }}
          />
        </div>
      );
    }

    return (
      <pre className="my-4 max-w-full overflow-x-auto rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed text-foreground select-text">
        <code>{text}</code>
      </pre>
    );
  }),
} satisfies Omit<Components, "a">;

export const MarkdownBody = memo(function MarkdownBody({
  content,
  testId,
  onOpenFilePath,
  worktreePath,
}: {
  content: string;
  testId?: string;
  onOpenFilePath?: (path: string) => void | Promise<void>;
  worktreePath?: string | null;
}) {
  const markdownComponents = useMemo<Components>(() => {
    const renderLink = createMarkdownRenderer<"a">((props) => (
      <MarkdownLink
        {...props}
        onOpenFilePath={onOpenFilePath}
        worktreePath={worktreePath}
      />
    ));

    return {
      ...BASE_MARKDOWN_COMPONENTS,
      a: renderLink,
    };
  }, [onOpenFilePath, worktreePath]);

  return (
    <div data-testid={testId}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

export const AssistantContent = memo(function AssistantContent({
  content,
  renderHint,
  rawFileLanguage,
  isCompleted,
  onOpenFilePath,
  worktreePath,
}: {
  content: string;
  renderHint?: AssistantRenderHint;
  rawFileLanguage?: string;
  isCompleted?: boolean;
  onOpenFilePath?: (path: string) => void | Promise<void>;
  worktreePath?: string | null;
}) {
  const mode: AssistantRenderHint = (() => {
    if (renderHint === "diff" || isLikelyDiff(content)) {
      return "diff";
    }

    if (renderHint === "raw-file") {
      return "raw-file";
    }

    if (renderHint === "raw-fallback") {
      return "raw-fallback";
    }

    if (!renderHint && isCompleted && hasUnclosedCodeFence(content)) {
      return "raw-fallback";
    }

    return "markdown";
  })();
  const displayContent = mode === "markdown" && !isCompleted
    ? collapseTrailingIncompleteMarkdownLink(content)
    : content;

  if (mode === "diff") {
    return (
      <div className="rounded-lg border border-border/40 bg-secondary/20 p-3" data-testid="assistant-render-diff">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Diff</div>
        <SafePatchDiff
          patch={content}
          options={{
            diffStyle: "unified",
            overflow: "wrap",
            theme: "pierre-dark",
            themeType: "dark",
            expandUnchanged: false,
            expansionLineCount: 20,
          }}
        />
      </div>
    );
  }

  if (mode === "raw-file") {
    if (!isCompleted) {
      return (
        <div className="space-y-2" data-testid="assistant-render-raw-file-stream">
          <div className="inline-flex rounded-md border border-border/40 bg-secondary/20 px-2 py-1 text-[11px] text-muted-foreground">
            Raw file stream
          </div>
          <RawFileBlock content={content} mode="raw-file" language={rawFileLanguage} splitNarrative streaming />
        </div>
      );
    }

    return <RawFileBlock content={content} mode="raw-file" language={rawFileLanguage} splitNarrative />;
  }

  if (mode === "raw-fallback") {
    return <RawFileBlock content={content} mode="raw-fallback" />;
  }

  return (
    <MarkdownBody
      content={displayContent}
      testId="assistant-render-markdown"
      onOpenFilePath={onOpenFilePath}
      worktreePath={worktreePath}
    />
  );
});
