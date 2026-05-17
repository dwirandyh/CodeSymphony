import { useCallback, useRef } from "react";
import type { Repository } from "@codesymphony/shared-types";
import { playCompletionSound } from "../../../lib/completionSounds";
import type { GeneralSettings } from "../../../lib/generalSettings";

export type ThreadCompletionAttentionEvent = {
  eventId: string;
  threadId: string;
  worktreeId: string;
  type: "chat.completed" | "chat.failed";
  threadTitle: string | null;
};

type UseCompletionAttentionParams = {
  generalSettings: GeneralSettings;
  repositories: Repository[];
  selectedThreadId: string | null;
  chatVisible: boolean;
};

function isAppFocused(): boolean {
  if (typeof document === "undefined") {
    return true;
  }

  if (document.visibilityState !== "visible") {
    return false;
  }

  return typeof document.hasFocus !== "function" || document.hasFocus();
}

export function shouldSuppressCompletionAttention(params: {
  appFocused: boolean;
  chatVisible: boolean;
  selectedThreadId: string | null;
  targetThreadId: string;
}): boolean {
  return params.appFocused
    && params.chatVisible
    && params.selectedThreadId === params.targetThreadId;
}

function resolveWorktreeLabel(repositories: Repository[], worktreeId: string): string | null {
  for (const repository of repositories) {
    const matchingWorktree = repository.worktrees.find((worktree) => worktree.id === worktreeId);
    if (!matchingWorktree) {
      continue;
    }

    return `${repository.name} · ${matchingWorktree.branch}`;
  }

  return null;
}

function buildNotificationCopy(params: {
  repositories: Repository[];
  event: ThreadCompletionAttentionEvent;
}): {
  title: string;
  body: string;
} {
  const location = resolveWorktreeLabel(params.repositories, params.event.worktreeId);
  const threadTitle = params.event.threadTitle?.trim() || null;

  if (params.event.type === "chat.failed") {
    return {
      title: "AI run failed",
      body: [threadTitle, location].filter((value): value is string => typeof value === "string" && value.length > 0).join(" · ")
        || "A background chat failed and needs attention.",
    };
  }

  return {
    title: "AI finished working",
    body: [threadTitle, location].filter((value): value is string => typeof value === "string" && value.length > 0).join(" · ")
      || "A background chat is ready to review.",
  };
}

function showDesktopNotification(params: {
  generalSettings: GeneralSettings;
  repositories: Repository[];
  event: ThreadCompletionAttentionEvent;
}) {
  if (!params.generalSettings.desktopNotificationsEnabled || typeof Notification === "undefined") {
    return;
  }

  if (Notification.permission !== "granted") {
    return;
  }

  const notificationCopy = buildNotificationCopy(params);

  try {
    const notification = new Notification(notificationCopy.title, {
      body: notificationCopy.body,
      tag: `codesymphony:${params.event.threadId}:${params.event.type}`,
      silent: true,
    });

    notification.onclick = () => {
      if (typeof window !== "undefined" && typeof window.focus === "function") {
        window.focus();
      }
    };
  } catch {
    // Best-effort only. Ignore browser notification failures.
  }
}

export function useCompletionAttention(params: UseCompletionAttentionParams) {
  const latestParamsRef = useRef(params);
  const seenEventIdsRef = useRef<Set<string>>(new Set());
  latestParamsRef.current = params;

  return useCallback((event: ThreadCompletionAttentionEvent) => {
    const latestParams = latestParamsRef.current;
    if (seenEventIdsRef.current.has(event.eventId)) {
      return;
    }

    seenEventIdsRef.current.add(event.eventId);

    const shouldPlaySound = latestParams.generalSettings.completionSound !== "off";
    const shouldShowNotification = latestParams.generalSettings.desktopNotificationsEnabled;
    if (!shouldPlaySound && !shouldShowNotification) {
      return;
    }

    if (shouldSuppressCompletionAttention({
      appFocused: isAppFocused(),
      chatVisible: latestParams.chatVisible,
      selectedThreadId: latestParams.selectedThreadId,
      targetThreadId: event.threadId,
    })) {
      return;
    }

    if (shouldPlaySound) {
      void playCompletionSound(latestParams.generalSettings.completionSound);
    }

    if (shouldShowNotification) {
      showDesktopNotification({
        generalSettings: latestParams.generalSettings,
        repositories: latestParams.repositories,
        event,
      });
    }
  }, []);
}
