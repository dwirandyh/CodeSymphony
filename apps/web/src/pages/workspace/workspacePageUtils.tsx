export function resolveChatMessageListKey(params: {
  previousKey: string;
  previousThreadId: string | null;
  nextThreadId: string | null;
}): string {
  const { previousKey, nextThreadId } = params;

  if (nextThreadId == null) {
    return previousKey;
  }

  if (previousKey !== nextThreadId) {
    return nextThreadId;
  }

  return previousKey;
}


export function FilledPlayIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
      <path fill="currentColor" d="M4 2.5v11l9-5.5-9-5.5z" />
    </svg>
  );
}

export function FilledPauseIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
      <rect x="3.5" y="2.5" width="3.5" height="11" rx="0.8" fill="currentColor" />
      <rect x="9" y="2.5" width="3.5" height="11" rx="0.8" fill="currentColor" />
    </svg>
  );
}
