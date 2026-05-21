const STARTUP_RUNTIME_READY_EVENT = "codesymphony:startup-runtime-ready";

type StartupRuntimeReadyDetail = {
  source: string;
};

function createStartupRuntimeReadyEvent(detail: StartupRuntimeReadyDetail) {
  return new CustomEvent<StartupRuntimeReadyDetail>(STARTUP_RUNTIME_READY_EVENT, {
    detail,
  });
}

export function notifyStartupRuntimeReady(source: string) {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") {
    return;
  }

  window.dispatchEvent(createStartupRuntimeReadyEvent({ source }));
}

export function subscribeStartupRuntimeReady(
  listener: (detail: StartupRuntimeReadyDetail) => void,
) {
  if (
    typeof window === "undefined"
    || typeof window.addEventListener !== "function"
    || typeof window.removeEventListener !== "function"
  ) {
    return () => undefined;
  }

  const handleEvent = (event: Event) => {
    const customEvent = event as CustomEvent<StartupRuntimeReadyDetail>;
    listener(customEvent.detail ?? { source: "unknown" });
  };

  window.addEventListener(STARTUP_RUNTIME_READY_EVENT, handleEvent);
  return () => {
    window.removeEventListener(STARTUP_RUNTIME_READY_EVENT, handleEvent);
  };
}
