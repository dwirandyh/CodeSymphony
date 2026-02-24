import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Run Prisma migrations in production.
 * Uses process.execPath (the bundled Node.js binary) to invoke prisma CLI.
 */
export function runPrismaMigrations(): void {
  const schemaPath = process.env.PRISMA_SCHEMA_PATH;
  const migrationsDir = process.env.PRISMA_MIGRATIONS_DIR;

  if (!schemaPath) {
    console.log("PRISMA_SCHEMA_PATH not set, skipping migrations");
    return;
  }

  // Resolve prisma CLI from node_modules
  const prismaCliPath = path.resolve(
    path.dirname(schemaPath),
    "..",
    "node_modules",
    ".prisma",
    "engines",
  );

  const prismaBin = path.resolve(
    path.dirname(schemaPath),
    "..",
    "node_modules",
    "prisma",
    "build",
    "index.js",
  );

  const args = ["migrate", "deploy", "--schema", schemaPath];

  console.log(`Running Prisma migrations (schema: ${schemaPath})`);

  try {
    execFileSync(process.execPath, [prismaBin, ...args], {
      stdio: "inherit",
      env: {
        ...process.env,
        PRISMA_ENGINES_DIR: prismaCliPath,
        ...(migrationsDir ? { PRISMA_MIGRATIONS_DIR: migrationsDir } : {}),
      },
    });
    console.log("Prisma migrations completed successfully");
  } catch (error) {
    console.error("Prisma migration failed:", error);
    throw error;
  }
}
