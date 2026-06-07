// Browser shim for Node's `node:diagnostics_channel`.
//
// `@xterm/addon-ligatures` pulls in `lru-cache`, which imports
// `node:diagnostics_channel` for optional instrumentation. That module does
// not exist in the browser, and Vite's default `__vite-browser-external` stub
// does not export the named `channel`/`tracingChannel` bindings lru-cache
// references, so the production rollup build fails. This no-op shim provides
// inert implementations so the bundle builds and runs in the browser.

class NoopChannel {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  get hasSubscribers(): boolean {
    return false;
  }

  publish(): void {}

  subscribe(): void {}

  unsubscribe(): boolean {
    return false;
  }

  bindStore(): void {}

  unbindStore(): void {}
}

class NoopTracingChannel {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  get hasSubscribers(): boolean {
    return false;
  }

  subscribe(): void {}

  unsubscribe(): boolean {
    return false;
  }

  traceSync<T>(fn: (...args: unknown[]) => T, _context: unknown, thisArg: unknown, ...args: unknown[]): T {
    return fn.apply(thisArg, args);
  }

  tracePromise<T>(fn: (...args: unknown[]) => Promise<T>, _context: unknown, thisArg: unknown, ...args: unknown[]): Promise<T> {
    return fn.apply(thisArg, args);
  }

  traceCallback(fn: (...args: unknown[]) => unknown, position: number, _context: unknown, thisArg: unknown, ...args: unknown[]): unknown {
    void position;
    return fn.apply(thisArg, args);
  }
}

export function channel(name: string): NoopChannel {
  return new NoopChannel(name);
}

export function tracingChannel(name: string): NoopTracingChannel {
  return new NoopTracingChannel(name);
}

export function hasSubscribers(): boolean {
  return false;
}

export function subscribe(): void {}

export function unsubscribe(): boolean {
  return false;
}

export default {
  channel,
  tracingChannel,
  hasSubscribers,
  subscribe,
  unsubscribe,
};
