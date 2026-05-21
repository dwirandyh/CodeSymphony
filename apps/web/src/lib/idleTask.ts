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

  let completed = false;
  let timeoutId: number | null = null;
  let idleHandle: number | null = null;
  const finish = () => {
    if (completed) {
      return;
    }

    completed = true;
    if (timeoutId != null) {
      window.clearTimeout(timeoutId);
      timeoutId = null;
    }

    if (idleHandle != null && typeof idleWindow.cancelIdleCallback === "function") {
      idleWindow.cancelIdleCallback(idleHandle);
      idleHandle = null;
    }

    callback();
  };
  const idleWindow = window as WindowWithIdleCallback;
  if (typeof idleWindow.requestIdleCallback === "function") {
    idleHandle = idleWindow.requestIdleCallback(finish, {
      timeout: options?.timeout ?? 0,
    });

    const fallbackDelayMs = Math.max(0, options?.timeout ?? options?.fallbackDelayMs ?? 0);
    timeoutId = window.setTimeout(finish, fallbackDelayMs);

    return () => {
      completed = true;
      if (timeoutId != null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (idleHandle != null && typeof idleWindow.cancelIdleCallback === "function") {
        idleWindow.cancelIdleCallback(idleHandle);
        idleHandle = null;
      }
    };
  }

  timeoutId = window.setTimeout(finish, options?.fallbackDelayMs ?? 0);
  return () => {
    completed = true;
    if (timeoutId != null) {
      window.clearTimeout(timeoutId);
      timeoutId = null;
    }
  };
}
