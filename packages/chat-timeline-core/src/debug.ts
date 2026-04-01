type TimelineDebugLogger = (...args: unknown[]) => void;

let timelineDebugLogger: TimelineDebugLogger | null = null;

export function setTimelineDebugLogger(logger: TimelineDebugLogger | null): void {
  timelineDebugLogger = logger;
}

export function pushRenderDebug(...args: unknown[]): void {
  timelineDebugLogger?.(...args);
}
