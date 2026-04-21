import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import {
  getConfiguredRuntimeProxyTarget,
  getConfiguredWebDevPort,
} from "./runtimeConfig";

export default defineConfig(({ mode }) => {
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
    server: {
      port: parseInt(getConfiguredWebDevPort(process.env), 10),
      host: true,
      proxy: {
        "/api": {
          target: getConfiguredRuntimeProxyTarget(process.env),
          changeOrigin: true,
        },
      },
    },
  };
});
