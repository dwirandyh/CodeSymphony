import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyPendingMigrations,
  collectBundledMigrations,
  computePendingMigrations,
  type BundledMigration,
  type RawSqliteDatabase,
} from "../src/db/rawSqliteMigrator";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function migrationsFixture(
  migrations: Array<{ name: string; sql: string }>,
): string {
  const root = mkdtempSync(path.join(tmpdir(), "raw-migrator-"));
  tempDirs.push(root);
  for (const migration of migrations) {
    const dir = path.join(root, migration.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "migration.sql"), migration.sql);
  }
  return root;
}

type RecordedMigration = { name: string; checksum: string };

function createFakeDb(initialApplied: string[] = []): RawSqliteDatabase & {
  executed: string[];
  recorded: RecordedMigration[];
} {
  const recorded: RecordedMigration[] = initialApplied.map((name) => ({ name, checksum: "seed" }));
  const executed: string[] = [];
  return {
    executed,
    recorded,
    exec(sql: string) {
      executed.push(sql);
    },
    appliedMigrationNames() {
      return recorded.map((row) => row.name);
    },
    recordMigration(migration: BundledMigration) {
      recorded.push({ name: migration.name, checksum: migration.checksum });
    },
    transaction(run: () => void) {
      run();
    },
    close() {},
  };
}

describe("collectBundledMigrations", () => {
  it("orders migrations and flags comment-only bodies as non-executable", () => {
    const dir = migrationsFixture([
      { name: "0002_second", sql: "ALTER TABLE ChatThread ADD COLUMN x TEXT;" },
      { name: "0001_first", sql: "-- only a comment\n/* nothing to run */\n" },
    ]);

    const bundled = collectBundledMigrations(dir);

    expect(bundled.map((m) => m.name)).toEqual(["0001_first", "0002_second"]);
    expect(bundled[0].hasExecutableSql).toBe(false);
    expect(bundled[1].hasExecutableSql).toBe(true);
    expect(bundled[0].checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns an empty list when the directory does not exist", () => {
    expect(collectBundledMigrations(path.join(tmpdir(), "missing-migrations-dir"))).toEqual([]);
  });
});

describe("computePendingMigrations", () => {
  it("returns only migrations missing from the applied set", () => {
    const bundled: BundledMigration[] = [
      { name: "a", sql: "", checksum: "1", hasExecutableSql: true },
      { name: "b", sql: "", checksum: "2", hasExecutableSql: true },
      { name: "c", sql: "", checksum: "3", hasExecutableSql: true },
    ];

    const pending = computePendingMigrations(bundled, ["a", "b"]);

    expect(pending.map((m) => m.name)).toEqual(["c"]);
  });
});

describe("applyPendingMigrations", () => {
  it("applies and records only the pending migration on an upgraded database", () => {
    const dir = migrationsFixture([
      { name: "0001_init", sql: "CREATE TABLE ChatThread (id TEXT);" },
      { name: "0002_add_model_options_per_model", sql: 'ALTER TABLE "ChatThread" ADD COLUMN "modelOptionsPerModel" TEXT;' },
    ]);
    const bundled = collectBundledMigrations(dir);
    const db = createFakeDb(["0001_init"]);

    const result = applyPendingMigrations(db, bundled);

    expect(result.applied).toEqual(["0002_add_model_options_per_model"]);
    expect(db.recorded.map((row) => row.name)).toEqual([
      "0001_init",
      "0002_add_model_options_per_model",
    ]);
    expect(db.executed).toContain('ALTER TABLE "ChatThread" ADD COLUMN "modelOptionsPerModel" TEXT;');
    expect(db.executed).not.toContain("CREATE TABLE ChatThread (id TEXT);");
    expect(db.executed).toContain("PRAGMA foreign_keys=OFF;");
  });

  it("records comment-only migrations without executing their body", () => {
    const dir = migrationsFixture([
      { name: "0001_comment_only", sql: "-- enum extension; no DDL needed\n" },
    ]);
    const bundled = collectBundledMigrations(dir);
    const db = createFakeDb();

    const result = applyPendingMigrations(db, bundled);

    expect(result.applied).toEqual(["0001_comment_only"]);
    expect(db.recorded.map((row) => row.name)).toEqual(["0001_comment_only"]);
    expect(db.executed.some((sql) => sql.includes("enum extension"))).toBe(false);
  });

  it("is a no-op when every bundled migration is already applied", () => {
    const dir = migrationsFixture([{ name: "0001_init", sql: "CREATE TABLE ChatThread (id TEXT);" }]);
    const bundled = collectBundledMigrations(dir);
    const db = createFakeDb(["0001_init"]);

    const result = applyPendingMigrations(db, bundled);

    expect(result.applied).toEqual([]);
    expect(db.executed).not.toContain("PRAGMA foreign_keys=OFF;");
  });

  it("applies the full real bundled migration history on a fresh database", () => {
    const dir = path.resolve("prisma/migrations");
    const bundled = collectBundledMigrations(dir);
    expect(bundled.length).toBeGreaterThan(0);
    const db = createFakeDb();

    const result = applyPendingMigrations(db, bundled);

    expect(result.applied).toEqual(bundled.map((m) => m.name));
    expect(
      bundled.some((m) => m.sql.includes("modelOptionsPerModel")),
    ).toBe(true);
  });
});
