import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const prismaMocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
}));

vi.mock("../src/db/prisma.js", () => ({
  prisma: {
    $queryRaw: prismaMocks.queryRaw,
  },
}));

import { createPrismaMigrationExecutionPlan, runPrismaMigrations } from "../src/migrate.js";

const originalEnv = { ...process.env };
const tempDirs: string[] = [];

function createFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "codesymphony-migrate-"));
  tempDirs.push(root);

  const prismaDir = path.join(root, "prisma");
  const migrationsDir = path.join(prismaDir, "migrations", "20260515000000_init");
  const appDataDir = path.join(root, "app-data");
  const markerPath = path.join(root, "app-data", "prisma-migrations.sha1");
  const dbPath = path.join(root, "app-data", "codesymphony.db");

  mkdirSync(migrationsDir, { recursive: true });
  mkdirSync(appDataDir, { recursive: true });
  writeFileSync(path.join(prismaDir, "schema.prisma"), "model ChatThread { id String @id }\n");
  writeFileSync(path.join(migrationsDir, "migration.sql"), "create table ChatThread(id text primary key);\n");
  writeFileSync(dbPath, "");

  return {
    dbPath,
    markerPath,
    migrationsDir: path.join(prismaDir, "migrations"),
    schemaPath: path.join(prismaDir, "schema.prisma"),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  prismaMocks.queryRaw.mockReset();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("runPrismaMigrations", () => {
  it("skips the prisma CLI when the database already matches the bundled migrations", async () => {
    const fixture = createFixture();
    process.env.PRISMA_SCHEMA_PATH = fixture.schemaPath;
    process.env.PRISMA_MIGRATIONS_DIR = fixture.migrationsDir;
    process.env.DATABASE_URL = `file:${fixture.dbPath}`;

    prismaMocks.queryRaw.mockResolvedValue([{ migration_name: "20260515000000_init" }]);

    const plan = createPrismaMigrationExecutionPlan();
    const result = await runPrismaMigrations({ plan });

    expect(result.executed).toBe(false);
    expect(result.reason).toBe("database-unchanged");
    expect(prismaMocks.queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe("createPrismaMigrationExecutionPlan", () => {
  it("runs migrations when the marker file is missing", () => {
    const fixture = createFixture();
    process.env.PRISMA_SCHEMA_PATH = fixture.schemaPath;
    process.env.PRISMA_MIGRATIONS_DIR = fixture.migrationsDir;
    process.env.PRISMA_MIGRATION_MARKER_PATH = fixture.markerPath;
    process.env.DATABASE_URL = `file:${fixture.dbPath}`;

    const plan = createPrismaMigrationExecutionPlan();

    expect(plan.shouldRun).toBe(true);
    expect(plan.reason).toBe("marker-missing");
    expect(plan.signature).toMatch(/^[a-f0-9]{40}$/);
  });

  it("skips migrations when the marker matches the bundled migration signature", () => {
    const fixture = createFixture();
    process.env.PRISMA_SCHEMA_PATH = fixture.schemaPath;
    process.env.PRISMA_MIGRATIONS_DIR = fixture.migrationsDir;
    process.env.PRISMA_MIGRATION_MARKER_PATH = fixture.markerPath;
    process.env.DATABASE_URL = `file:${fixture.dbPath}`;

    const initialPlan = createPrismaMigrationExecutionPlan();
    writeFileSync(fixture.markerPath, `${initialPlan.signature}\n`);

    const plan = createPrismaMigrationExecutionPlan();

    expect(plan.shouldRun).toBe(false);
    expect(plan.reason).toBe("signature-unchanged");
  });

  it("forces migrations when the database file is missing even if the marker matches", () => {
    const fixture = createFixture();
    process.env.PRISMA_SCHEMA_PATH = fixture.schemaPath;
    process.env.PRISMA_MIGRATIONS_DIR = fixture.migrationsDir;
    process.env.PRISMA_MIGRATION_MARKER_PATH = fixture.markerPath;
    process.env.DATABASE_URL = `file:${fixture.dbPath}`;

    const initialPlan = createPrismaMigrationExecutionPlan();
    writeFileSync(fixture.markerPath, `${initialPlan.signature}\n`);
    rmSync(fixture.dbPath, { force: true });

    const plan = createPrismaMigrationExecutionPlan();

    expect(plan.shouldRun).toBe(true);
    expect(plan.reason).toBe("database-missing");
  });
});
