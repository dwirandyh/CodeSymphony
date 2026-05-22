import { Files, GitBranch, Grip, MessageSquareText } from "lucide-react";
import { cn } from "../../lib/utils";

export function MobileActionBar({
  hasWorktree,
  gitChangeCount,
  activeSection,
  onShowChat,
  onOpenFiles,
  onOpenGit,
  onOpenMore,
}: {
  hasWorktree: boolean;
  gitChangeCount: number;
  activeSection: "chat" | "files" | "git" | "more";
  onShowChat: () => void;
  onOpenFiles: () => void;
  onOpenGit: () => void;
  onOpenMore: () => void;
}) {
  const buttons = [
    { key: "chat", label: "Chat", icon: MessageSquareText, onClick: onShowChat, disabled: false },
    { key: "files", label: "Files", icon: Files, onClick: onOpenFiles, disabled: !hasWorktree },
    {
      key: "git",
      label: "Git",
      icon: GitBranch,
      onClick: onOpenGit,
      disabled: !hasWorktree,
      badge: gitChangeCount > 0 ? `${Math.min(gitChangeCount, 99)}${gitChangeCount > 99 ? "+" : ""}` : undefined,
    },
    { key: "more", label: "More", icon: Grip, onClick: onOpenMore, disabled: false },
  ] as Array<{
    key: "chat" | "files" | "git" | "more";
    label: string;
    icon: typeof MessageSquareText;
    onClick: () => void;
    disabled: boolean;
    badge?: string;
  }>;

  return (
    <nav
      data-mobile-action-bar="true"
      className="shrink-0 border-t border-border/30 bg-[hsl(220,18%,10%)]/95 px-1.5 pb-2 pt-1 backdrop-blur-md safe-bottom lg:hidden sm:px-2.5"
    >
      <div className="grid grid-cols-4 gap-1">
        {buttons.map((button) => {
          const isActive = activeSection === button.key;
          return (
            <button
              key={button.key}
              type="button"
              onClick={button.onClick}
              disabled={button.disabled}
              className={cn(
                "relative flex min-h-[52px] flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-medium transition-colors",
                isActive ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
                button.disabled && "cursor-not-allowed opacity-40",
              )}
            >
              <button.icon className="h-4 w-4" />
              <span>{button.label}</span>
              {button.badge ? (
                <span className="absolute right-3 top-1.5 inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-primary px-1 text-[9px] font-bold leading-none text-primary-foreground">
                  {button.badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
