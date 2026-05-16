import { fileURLToPath, URL } from "node:url";
import { defineConfig, loadEnv, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import {
  getConfiguredRuntimeProxyTarget,
  getConfiguredWebDevPort,
  type RuntimeConfigViteEnv,
} from "./runtimeConfig";

export default defineConfig(({ mode }) => {
  const env = {
    ...process.env,
    ...loadEnv(mode, process.cwd(), ""),
  };
  const runtimeConfigEnv: RuntimeConfigViteEnv = {
    VITE_DEV_PORT: env.VITE_DEV_PORT,
    VITE_RUNTIME_PORT: env.VITE_RUNTIME_PORT,
    VITE_RUNTIME_PROXY_TARGET: env.VITE_RUNTIME_PROXY_TARGET,
  };
  const plugins: PluginOption[] = [
    TanStackRouterVite({
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
      quoteStyle: "double",
    }),
    react(),
  ];

  if (mode === "analyze") {
    plugins.push(
      import("rollup-plugin-visualizer").then(({ visualizer }: { visualizer: Function }) =>
        visualizer({ open: true, filename: "dist/stats.html", gzipSize: true })
      ) as unknown as PluginOption,
    );
  }

  return {
    plugins,
    resolve: {
      alias: {
        "@codesymphony/chat-timeline-core": fileURLToPath(
          new URL("../../packages/chat-timeline-core/src/index.ts", import.meta.url),
        ),
        "@codesymphony/shared-types": fileURLToPath(
          new URL("../../packages/shared-types/src/index.ts", import.meta.url),
        ),
      },
    },
    server: {
      port: parseInt(getConfiguredWebDevPort(runtimeConfigEnv), 10),
      host: true,
      proxy: {
        "/api": {
          target: getConfiguredRuntimeProxyTarget(runtimeConfigEnv),
          changeOrigin: true,
        },
      },
    },
  };
});
