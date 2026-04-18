import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";

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
      // @ts-expect-error -- installed as devDependency; types available after pnpm install
      import("rollup-plugin-visualizer").then(({ visualizer }: { visualizer: Function }) =>
        visualizer({ open: true, filename: "dist/stats.html", gzipSize: true })
      ) as unknown as PluginOption,
    );
  }

  return {
    plugins,
    server: {
      port: parseInt(process.env.VITE_DEV_PORT ?? "5173"),
      host: true,
      proxy: {
        "/api": {
          target: process.env.VITE_RUNTIME_PROXY_TARGET ?? "http://127.0.0.1:4331",
          changeOrigin: true,
        },
      },
    },
  };
});
