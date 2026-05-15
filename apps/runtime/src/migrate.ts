import { execFileSync } from "node:child_process";
import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { prisma } from "./db/prisma.js";

export type PrismaMigrationExecutionPlan = {
  schemaPath: string | null;
  prismaCliPath: string | null;
  prismaBin: string | null;
  migrationsDir: string | null;
  markerPath: string | null;
  signature: string | null;
  migrationNames: string[];
  databasePath: string | null;
  shouldRun: boolean;
  reason: string;
};

function resolveDatabasePath(databaseUrl: string | undefined): string | null {
  if (!databaseUrl?.startsWith("file:")) {
    return null;
  }

  const rawPath = databaseUrl.slice("file:".length);
  if (rawPath.length === 0) {
    return null;
  }

  if (rawPath.startsWith("//")) {
    try {
      return new URL(databaseUrl).pathname;
    } catch {
      return null;
    }
  }

  return path.resolve(process.cwd(), rawPath);
}

function collectBundledMigrationNames(migrationsDir: string | undefined): string[] {
  if (!migrationsDir || !existsSync(migrationsDir)) {
    return [];
  }

  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((migrationName) => existsSync(path.join(migrationsDir, migrationName, "migration.sql")))
    .sort();
}

function computeMigrationSignature(
  schemaPath: string,
  migrationNames: string[],
  migrationsDir: string | undefined,
): string {
  const hash = createHash("sha1");
  hash.update(readFileSync(schemaPath));

  for (const migrationName of migrationNames) {
    hash.update("\0");
    hash.update(migrationName);
    if (migrationsDir) {
      const migrationSqlPath = path.join(migrationsDir, migrationName, "migration.sql");
      if (existsSync(migrationSqlPath)) {
        hash.update("\0");
        hash.update(readFileSync(migrationSqlPath));
      }
    }
  }

  return hash.digest("hex");
}

function readMigrationMarker(markerPath: string | null): string | null {
  if (!markerPath || !existsSync(markerPath)) {
    return null;
  }

  return readFileSync(markerPath, "utf8").trim() || null;
}

function writeMigrationMarker(markerPath: string | null, signature: string | null) {
  if (!markerPath || !signature) {
    return;
  }

  mkdirSync(path.dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, `${signature}\n`, "utf8");
}

function sameMigrationSequence(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((migrationName, index) => migrationName === right[index]);
}

async function readAppliedMigrationNames(databasePath: string | null): Promise<string[] | null> {
  if (!databasePath || !existsSync(databasePath)) {
    return null;
  }

  try {
    const rows = await prisma.$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name
      FROM _prisma_migrations
      ORDER BY finished_at ASC
    `;

    return rows
      .map((row) => row.migration_name)
      .filter((name) => typeof name === "string" && name.length > 0);
  } catch {
    return null;
  }
}

export function createPrismaMigrationExecutionPlan(): PrismaMigrationExecutionPlan {
  const schemaPathFromEnv = process.env.PRISMA_SCHEMA_PATH;
  const fallbackSchemaPath = path.resolve(process.cwd(), "prisma", "schema.prisma");
  const schemaPath = schemaPathFromEnv ?? (existsSync(fallbackSchemaPath) ? fallbackSchemaPath : null);
  const migrationsDir = process.env.PRISMA_MIGRATIONS_DIR ?? null;
  const markerPath = process.env.PRISMA_MIGRATION_MARKER_PATH ?? null;
  const databasePath = resolveDatabasePath(process.env.DATABASE_URL);
  const migrationNames = collectBundledMigrationNames(migrationsDir ?? undefined);

  if (!schemaPath) {
    return {
      schemaPath: null,
      prismaCliPath: null,
      prismaBin: null,
      migrationsDir,
      markerPath,
      signature: null,
      migrationNames,
      databasePath,
      shouldRun: false,
      reason: "schema-missing",
    };
  }

  const prismaCliPath = process.env.PRISMA_ENGINES_DIR ?? path.resolve(
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
  const signature = computeMigrationSignature(schemaPath, migrationNames, migrationsDir ?? undefined);
  const currentMarker = readMigrationMarker(markerPath);

  if (!databasePath || !existsSync(databasePath)) {
    return {
      schemaPath,
      prismaCliPath,
      prismaBin,
      migrationsDir,
      markerPath,
      signature,
      migrationNames,
      databasePath,
      shouldRun: true,
      reason: "database-missing",
    };
  }

  if (!markerPath || currentMarker !== signature) {
    return {
      schemaPath,
      prismaCliPath,
      prismaBin,
      migrationsDir,
      markerPath,
      signature,
      migrationNames,
      databasePath,
      shouldRun: true,
      reason: currentMarker ? "marker-stale" : "marker-missing",
    };
  }

  return {
    schemaPath,
    prismaCliPath,
    prismaBin,
    migrationsDir,
    markerPath,
    signature,
    migrationNames,
    databasePath,
    shouldRun: false,
    reason: "signature-unchanged",
  };
}

/**
 * Run Prisma migrations in production.
 * Uses process.execPath (the bundled Node.js binary) to invoke prisma CLI.
 */
export async function runPrismaMigrations(options?: {
  force?: boolean;
  plan?: PrismaMigrationExecutionPlan;
}): Promise<{ executed: boolean; signature: string | null; reason: string }> {
  const plan = options?.plan ?? createPrismaMigrationExecutionPlan();
  const prismaQueryEngineLibrary = process.env.PRISMA_QUERY_ENGINE_LIBRARY;
  const prismaSchemaEngineBinary = process.env.PRISMA_SCHEMA_ENGINE_BINARY;

  if (!plan.schemaPath || !plan.prismaCliPath || !plan.prismaBin) {
    console.log("PRISMA schema not found, skipping migrations");
    return { executed: false, signature: null, reason: "schema-missing" };
  }

  if (!options?.force) {
    if (!plan.shouldRun) {
      console.log(`Skipping Prisma migrations (${plan.reason})`);
      return {
        executed: false,
        signature: plan.signature,
        reason: plan.reason,
      };
    }

    const appliedMigrationNames = await readAppliedMigrationNames(plan.databasePath);
    if (appliedMigrationNames != null && sameMigrationSequence(appliedMigrationNames, plan.migrationNames)) {
      console.log("Skipping Prisma migrations (database schema already matches bundled migrations)");
      writeMigrationMarker(plan.markerPath, plan.signature);
      return {
        executed: false,
        signature: plan.signature,
        reason: "database-unchanged",
      };
    }
  }

  const args = ["migrate", "deploy", "--schema", plan.schemaPath];

  console.log(`Running Prisma migrations (schema: ${plan.schemaPath})`);

  try {
    execFileSync(process.execPath, [plan.prismaBin, ...args], {
      stdio: "inherit",
      env: {
        ...process.env,
        PRISMA_ENGINES_DIR: plan.prismaCliPath,
        ...(prismaQueryEngineLibrary ? { PRISMA_QUERY_ENGINE_LIBRARY: prismaQueryEngineLibrary } : {}),
        ...(prismaSchemaEngineBinary ? { PRISMA_SCHEMA_ENGINE_BINARY: prismaSchemaEngineBinary } : {}),
        ...(plan.migrationsDir ? { PRISMA_MIGRATIONS_DIR: plan.migrationsDir } : {}),
      },
    });
    console.log("Prisma migrations completed successfully");
    writeMigrationMarker(plan.markerPath, plan.signature);
    return {
      executed: true,
      signature: plan.signature,
      reason: plan.reason,
    };
  } catch (error) {
    console.error("Prisma migration failed:", error);
    throw error;
  }
}
