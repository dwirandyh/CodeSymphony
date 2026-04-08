import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { AssistantRenderHint } from "./ChatMessageList.types";
import { isLikelyDiff, SafePatchDiff, hasUnclosedCodeFence, RawFileBlock } from "./diffUtils";

const MARKDOWN_COMPONENTS: React.ComponentProps<typeof ReactMarkdown>["components"] = {
  p: ({ children }) => <p className="leading-6 [&:not(:first-child)]:mt-4 whitespace-pre-wrap break-words">{children}</p>,
  ul: ({ children }) => <ul className="my-4 ml-6 list-disc [&>li]:mt-1.5">{children}</ul>,
  ol: ({ children }) => <ol className="my-4 ml-6 list-decimal [&>li]:mt-1.5">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  h1: ({ children }) => <h1 className="scroll-m-16 text-xl font-bold tracking-tight mb-3">{children}</h1>,
  h2: ({ children }) => <h2 className="scroll-m-16 border-b pb-1.5 text-lg font-semibold tracking-tight mt-5 mb-3 first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="scroll-m-16 text-base font-semibold tracking-tight mt-4 mb-2">{children}</h3>,
  h4: ({ children }) => <h4 className="scroll-m-16 text-sm font-semibold tracking-tight mt-3 mb-1.5">{children}</h4>,
  blockquote: ({ children }) => (
    <blockquote className="mt-4 border-l-2 border-primary pl-4 italic text-muted-foreground">{children}</blockquote>
  ),
  table: ({ children }) => (
    <div className="my-4 w-full overflow-x-auto text-sm">
      <table className="w-full border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b">{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr className="m-0 border-t p-0 even:bg-muted/50">{children}</tr>,
  th: ({ children }) => <th className="border px-3 py-1.5 text-left font-bold [&[align=center]]:text-center [&[align=right]]:text-right">{children}</th>,
  td: ({ children }) => <td className="border px-3 py-1.5 text-left [&[align=center]]:text-center [&[align=right]]:text-right">{children}</td>,
  a: ({ children, href }) => <a href={href} className="font-medium text-primary underline underline-offset-4 hover:text-primary/80" target="_blank" rel="noreferrer">{children}</a>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  code: ({ className, children }) => {
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
  },
};

export const MarkdownBody = memo(function MarkdownBody({
  content,
  testId,
}: {
  content: string;
  testId?: string;
}) {
  return (
    <div data-testid={testId}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={MARKDOWN_COMPONENTS}
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
}: {
  content: string;
  renderHint?: AssistantRenderHint;
  rawFileLanguage?: string;
  isCompleted?: boolean;
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

  return <MarkdownBody content={content} testId="assistant-render-markdown" />;
});
