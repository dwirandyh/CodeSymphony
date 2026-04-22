import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";

function getConfiguredWebDevPort() {
  const parsed = Number.parseInt(process.env.VITE_DEV_PORT ?? "", 10);
  return String(Number.isInteger(parsed) && parsed > 0 ? parsed : 5173);
}

function getConfiguredRuntimeProxyTarget() {
  if (process.env.VITE_RUNTIME_PROXY_TARGET) {
    return process.env.VITE_RUNTIME_PROXY_TARGET;
  }

  const parsedRuntimePort = Number.parseInt(process.env.VITE_RUNTIME_PORT ?? "", 10);
  const runtimePort = Number.isInteger(parsedRuntimePort) && parsedRuntimePort > 0
    ? parsedRuntimePort
    : 4331;
  return `http://127.0.0.1:${runtimePort}`;
}

export default defineConfig({
  plugins: [
    TanStackRouterVite({
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
      quoteStyle: "double",
    }),
    react(),
  ],
  server: {
    port: parseInt(getConfiguredWebDevPort(), 10),
    host: true,
    proxy: {
      "/api": {
        target: getConfiguredRuntimeProxyTarget(),
        changeOrigin: true,
      },
    },
  },
});
