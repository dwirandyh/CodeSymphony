import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
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
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./src/test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html"],
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: [
        "**/*.test.*",
        "**/test/**",
        "src/main.tsx",
        "src/routes/**",
        "src/routeTree.gen.ts",
        "src/components/ui/**",
        "src/vite-env.d.ts",
        "src/pages/workspace/types.ts",
        "src/pages/WorkspacePage.tsx",
      ],
    },
  },
});
