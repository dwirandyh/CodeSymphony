import { useState } from "react";
import { ChevronDown, ChevronUp, Copy, Download, Check } from "lucide-react";
import { Card, CardContent, CardHeader } from "../ui/card";
import { Button } from "../ui/button";
import { MarkdownBody } from "./ChatMessageList";

type PlanCardStatus = "pending" | "revising" | "sending" | "approved" | "superseded";

type PlanCardProps = {
  content: string;
  filePath: string;
  status: PlanCardStatus;
  onApprove: () => void;
  onRevise: (feedback: string) => void;
};

function extractPlanTitle(content: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || "Plan";
}

export function PlanCard({ content, filePath, status, onApprove, onRevise }: PlanCardProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showReviseInput, setShowReviseInput] = useState(false);
  const [revisionFeedback, setRevisionFeedback] = useState("");

  const title = extractPlanTitle(content);
  const isDisabled = status === "sending" || status === "approved" || status === "superseded";
  const canInteract = status === "pending" || status === "revising";

  function handleCopy() {
    if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") {
      return;
    }
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function handleDownload() {
    const blob = new Blob([content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    const fileName = filePath.split("/").pop() ?? "plan.md";
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function handleReviseClick() {
    if (showReviseInput) {
      setShowReviseInput(false);
      setRevisionFeedback("");
    } else {
      setShowReviseInput(true);
    }
  }

  function handleSendRevision() {
    const trimmed = revisionFeedback.trim();
    if (trimmed.length === 0) {
      return;
    }
    onRevise(trimmed);
    setShowReviseInput(false);
    setRevisionFeedback("");
  }

  if (status === "superseded") {
    return null;
  }

  return (
    <Card className="border-amber-500/30 bg-card/80">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-400">
            Plan
          </span>
          {status === "approved" ? (
            <span className="rounded-md bg-green-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-green-400">
              Approved
            </span>
          ) : null}
          {status === "sending" ? (
            <span className="rounded-md bg-blue-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-blue-400">
              Revising...
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="rounded-md p-1.5 text-muted-foreground/60 transition-colors hover:text-foreground"
            onClick={handleDownload}
            aria-label="Download plan"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="rounded-md p-1.5 text-muted-foreground/60 transition-colors hover:text-foreground"
            onClick={handleCopy}
            aria-label="Copy plan"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            className="rounded-md p-1.5 text-muted-foreground/60 transition-colors hover:text-foreground"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? "Expand plan" : "Collapse plan"}
          >
            {collapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
          </button>
        </div>
      </CardHeader>

      {!collapsed ? (
        <CardContent className="px-4 pb-4 pt-0">
          <div className="prose-sm max-h-[60vh] overflow-y-auto text-sm text-foreground/90">
            <MarkdownBody content={content} testId="plan-card-markdown" />
          </div>
        </CardContent>
      ) : (
        <CardContent className="px-4 pb-3 pt-0">
          <p className="text-sm font-medium text-foreground/80">{title}</p>
        </CardContent>
      )}

      {canInteract ? (
        <div className="border-t border-border/30 px-4 py-3">
          {showReviseInput ? (
            <div className="space-y-2">
              <textarea
                value={revisionFeedback}
                onChange={(e) => setRevisionFeedback(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && revisionFeedback.trim().length > 0) {
                    e.preventDefault();
                    handleSendRevision();
                  }
                }}
                placeholder="Describe what to change..."
                className="w-full resize-none rounded-md border border-border/35 bg-background/35 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-amber-500/50 focus:outline-none focus:ring-1 focus:ring-amber-500/30"
                rows={3}
                autoFocus
              />
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={revisionFeedback.trim().length === 0}
                  className="h-8 rounded-md px-4 text-xs"
                  onClick={handleSendRevision}
                >
                  Send Revision
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-8 rounded-md px-3 text-xs"
                  onClick={() => {
                    setShowReviseInput(false);
                    setRevisionFeedback("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={isDisabled}
                className="h-8 rounded-md px-4 text-xs"
                onClick={onApprove}
              >
                Approve &amp; Execute
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={isDisabled}
                className="h-8 rounded-md border-border/55 bg-transparent px-3 text-xs text-muted-foreground hover:text-foreground"
                onClick={handleReviseClick}
              >
                Request Revision
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </Card>
  );
}
