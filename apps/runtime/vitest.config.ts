import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "**/*.test.*",
        "**/test/**",
        "src/index.ts",
        "src/migrate.ts",
        "src/types.ts",
        "src/db/prisma.ts",
      ],
    },
  },
});
