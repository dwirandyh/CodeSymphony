import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig, env } from "prisma/config";

const envFilePath = path.resolve(import.meta.dirname, ".env");

if (typeof process.loadEnvFile === "function" && existsSync(envFilePath)) {
  process.loadEnvFile(envFilePath);
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "bun prisma/seed.ts",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
