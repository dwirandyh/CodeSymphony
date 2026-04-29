type WindowWithIdleCallback = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

export function scheduleWindowIdleTask(
  callback: () => void,
  options?: {
    timeout?: number;
    fallbackDelayMs?: number;
  },
): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const idleWindow = window as WindowWithIdleCallback;
  if (typeof idleWindow.requestIdleCallback === "function") {
    const idleHandle = idleWindow.requestIdleCallback(callback, {
      timeout: options?.timeout ?? 0,
    });

    return () => {
      if (typeof idleWindow.cancelIdleCallback === "function") {
        idleWindow.cancelIdleCallback(idleHandle);
      }
    };
  }

  const timeoutId = window.setTimeout(callback, options?.fallbackDelayMs ?? 0);
  return () => {
    window.clearTimeout(timeoutId);
  };
}
