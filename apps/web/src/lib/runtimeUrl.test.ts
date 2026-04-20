import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("resolveRuntimeApiBase", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("module exports resolve functions", async () => {
    const mod = await import("./runtimeUrl");
    expect(typeof mod.resolveRuntimeApiBase).toBe("function");
    expect(typeof mod.resolveRuntimeApiBases).toBe("function");
  });

  it("uses runtime port when opened from the web dev server port", async () => {
    vi.stubGlobal("window", {
      location: {
        protocol: "http:",
        hostname: "localhost",
        origin: "http://localhost:5173",
        port: "5173",
      },
    } as Window);

    const mod = await import("./runtimeUrl");
    expect(mod.resolveRuntimeApiBase()).toBe("http://localhost:4331/api");
    expect(mod.resolveRuntimeApiBases()).toEqual([
      "http://localhost:4331/api",
      "http://localhost:4321/api",
    ]);
  });

  it("uses the current hostname for LAN web dev access", async () => {
    vi.stubGlobal("window", {
      location: {
        protocol: "http:",
        hostname: "192.168.1.42",
        origin: "http://192.168.1.42:5173",
        port: "5173",
      },
    } as Window);

    const mod = await import("./runtimeUrl");
    expect(mod.resolveRuntimeApiBase()).toBe("http://192.168.1.42:4331/api");
    expect(mod.resolveRuntimeApiBases()).toEqual([
      "http://192.168.1.42:4331/api",
      "http://192.168.1.42:4321/api",
    ]);
  });

  it("honors an explicit runtime url override", async () => {
    vi.stubEnv("VITE_RUNTIME_URL", "http://127.0.0.1:4999/api");
    vi.stubGlobal("window", {
      location: {
        protocol: "http:",
        hostname: "192.168.1.42",
        origin: "http://192.168.1.42:5173",
        port: "5173",
      },
    } as Window);

    const mod = await import("./runtimeUrl");
    expect(mod.resolveRuntimeApiBase()).toBe("http://127.0.0.1:4999/api");
    expect(mod.resolveRuntimeApiBases()).toEqual(["http://127.0.0.1:4999/api"]);
  });

  it("uses the injected desktop runtime port inside a tauri window", async () => {
    vi.stubGlobal("window", {
      __CS_RUNTIME_PORT: 4327,
      __TAURI_INTERNALS__: {},
      location: {
        protocol: "http:",
        hostname: "127.0.0.1",
        origin: "http://127.0.0.1:5174",
        port: "5174",
      },
    } as Window);

    const mod = await import("./runtimeUrl");
    expect(mod.resolveRuntimeApiBase()).toBe("http://127.0.0.1:4327/api");
    expect(mod.resolveRuntimeApiBases()).toEqual(["http://127.0.0.1:4327/api"]);
  });

  it("uses runtime port for non-default vite dev ports in dev mode", async () => {
    vi.stubGlobal("window", {
      location: {
        protocol: "http:",
        hostname: "localhost",
        origin: "http://localhost:5174",
        port: "5174",
      },
    } as Window);

    vi.stubEnv("VITE_DEV_PORT", "5173");

    const mod = await import("./runtimeUrl");
    expect(mod.resolveRuntimeApiBase()).toBe("http://localhost:4331/api");
    expect(mod.resolveRuntimeApiBases()).toEqual([
      "http://localhost:4331/api",
      "http://localhost:4321/api",
    ]);
  });

  it("uses runtime port for fallback vite ports even without explicit env hints", async () => {
    vi.stubGlobal("window", {
      location: {
        protocol: "http:",
        hostname: "127.0.0.1",
        origin: "http://127.0.0.1:5175",
        port: "5175",
      },
    } as Window);

    const mod = await import("./runtimeUrl");
    expect(mod.resolveRuntimeApiBase()).toBe("http://127.0.0.1:4331/api");
    expect(mod.resolveRuntimeApiBases()).toEqual([
      "http://127.0.0.1:4331/api",
      "http://127.0.0.1:4321/api",
    ]);
  });

  it("uses same-origin api when not on the web dev server port", async () => {
    vi.stubGlobal("window", {
      location: {
        protocol: "http:",
        hostname: "localhost",
        origin: "http://localhost:4331",
        port: "4331",
      },
    } as Window);

    const mod = await import("./runtimeUrl");
    expect(mod.resolveRuntimeApiBase()).toBe("http://localhost:4331/api");
    expect(mod.resolveRuntimeApiBases()).toEqual(["http://localhost:4331/api"]);
  });
});
