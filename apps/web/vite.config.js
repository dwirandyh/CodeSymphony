import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";

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
    port: parseInt(process.env.VITE_DEV_PORT ?? "5173"),
    host: true,
    proxy: {
      "/api": {
        target: process.env.VITE_RUNTIME_PROXY_TARGET ?? "http://127.0.0.1:4331",
        changeOrigin: true,
      },
    },
  },
});
