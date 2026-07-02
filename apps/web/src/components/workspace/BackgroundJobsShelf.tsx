import { useState, type CSSProperties } from "react";
import { ChevronDown, Square } from "lucide-react";
import type { ActiveBackgroundJob } from "../../pages/workspace/backgroundJobUtils";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";

type BackgroundJobsShelfProps = {
  jobs: ActiveBackgroundJob[];
  attached?: boolean;
  onStopJob?: (toolUseId: string) => void;
};

const JOB_PREVIEW_STYLE: CSSProperties = {
  display: "-webkit-box",
  overflow: "hidden",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 2,
};

function formatElapsed(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) {
    return "running";
  }
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  if (minutes <= 0) {
    return `${remainder}s`;
  }
  return `${minutes}m ${remainder}s`;
}

function shelfLabel(count: number): string {
  if (count === 1) {
    return "1 monitoring";
  }
  return `${count} monitoring`;
}

export function BackgroundJobsShelf({ jobs, attached = false, onStopJob }: BackgroundJobsShelfProps) {
  const [collapsed, setCollapsed] = useState(attached);

  if (jobs.length === 0) {
    return null;
  }

  const stopDisabled = onStopJob == null;

  const content = !collapsed ? (
    <div className="mt-2.5 divide-y divide-border/35">
      {jobs.map((job) => (
        <div key={job.toolUseId} className="flex items-start gap-2 py-2 first:pt-0 last:pb-0">
          <div className="min-w-0 flex-1">
            <p
              title={job.label}
              style={JOB_PREVIEW_STYLE}
              className="break-words text-[13px] leading-5 text-foreground"
            >
              {job.label}
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{formatElapsed(job.elapsedSeconds)}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 rounded-full text-muted-foreground/80 hover:bg-secondary/60 hover:text-foreground"
            disabled={stopDisabled}
            aria-label="Stop monitoring"
            title={stopDisabled ? "Per-monitor stop is not available yet" : "Stop this monitor"}
            onClick={() => onStopJob?.(job.toolUseId)}
          >
            <Square className="h-3.5 w-3.5" fill="currentColor" />
          </Button>
        </div>
      ))}
    </div>
  ) : null;

  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-[13px] font-medium leading-5 text-foreground">{shelfLabel(jobs.length)}</p>
        <button
          type="button"
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full text-[11px] text-muted-foreground transition hover:bg-secondary/60 hover:text-foreground",
            attached ? "h-6 w-6 justify-center" : "h-7 px-2",
          )}
          onClick={() => setCollapsed((current) => !current)}
          aria-label={collapsed ? "Expand monitoring" : "Collapse monitoring"}
          title={collapsed ? "Expand monitoring" : "Collapse monitoring"}
        >
          {attached ? null : <span>{collapsed ? "Show" : "Hide"}</span>}
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", collapsed && "-rotate-90")} />
        </button>
      </div>
      {content}
    </>
  );

  if (attached) {
    return (
      <div
        data-testid="attached-background-jobs-shelf"
        className="rounded-t-xl border border-b-0 border-border/60 bg-card/80 px-4 py-1.5 shadow-sm backdrop-blur-sm"
      >
        {body}
      </div>
    );
  }

  return (
    <section className="pb-2 pt-1.5">
      <div className="mx-auto w-full max-w-3xl">
        <div className="rounded-[28px] border border-border/60 bg-card/80 px-3 py-3 shadow-sm backdrop-blur-sm">
          {body}
        </div>
      </div>
    </section>
  );
}