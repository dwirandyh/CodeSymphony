// React 19 act() warning suppression in Vitest + jsdom.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();

  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(String(key), String(value));
    },
  } as Storage;
}

function ensureStorageApi(name: "localStorage" | "sessionStorage"): void {
  const storage = globalThis[name];
  if (
    storage
    && typeof storage.getItem === "function"
    && typeof storage.setItem === "function"
    && typeof storage.removeItem === "function"
    && typeof storage.clear === "function"
    && typeof storage.key === "function"
  ) {
    return;
  }

  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value: createMemoryStorage(),
  });
}

ensureStorageApi("localStorage");
ensureStorageApi("sessionStorage");
