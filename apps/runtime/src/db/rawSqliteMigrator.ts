import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type BundledMigration = {
  name: string;
  sql: string;
  checksum: string;
  hasExecutableSql: boolean;
};

export interface RawSqliteDatabase {
  exec(sql: string): void;
  appliedMigrationNames(): string[];
  recordMigration(migration: BundledMigration): void;
  transaction(run: () => void): void;
  close(): void;
}

const PRISMA_MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "checksum" TEXT NOT NULL,
  "finished_at" DATETIME,
  "migration_name" TEXT NOT NULL,
  "logs" TEXT,
  "rolled_back_at" DATETIME,
  "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
  "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
);`;

/**
 * Strip SQL comments to detect migrations whose body is comment-only.
 * `bun:sqlite`'s `exec` throws on a comment-only script, so those migrations
 * must be recorded without being executed.
 */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "")
    .trim();
}

export function collectBundledMigrations(migrationsDir: string): BundledMigration[] {
  if (!existsSync(migrationsDir)) {
    return [];
  }

  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(path.join(migrationsDir, name, "migration.sql")))
    .sort()
    .map((name) => {
      const sql = readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8");
      return {
        name,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
        hasExecutableSql: stripSqlComments(sql).length > 0,
      };
    });
}

export function computePendingMigrations(
  bundled: BundledMigration[],
  appliedNames: Iterable<string>,
): BundledMigration[] {
  const applied = new Set(appliedNames);
  return bundled.filter((migration) => !applied.has(migration.name));
}

/**
 * Apply pending bundled migrations to an existing SQLite database using a
 * provided executor. Each migration runs in its own transaction and is then
 * recorded in `_prisma_migrations`, mirroring `prisma migrate deploy` while
 * preserving existing user data.
 */
export function applyPendingMigrations(
  db: RawSqliteDatabase,
  bundled: BundledMigration[],
): { applied: string[] } {
  db.exec(PRISMA_MIGRATIONS_DDL);
  const pending = computePendingMigrations(bundled, db.appliedMigrationNames());
  if (pending.length === 0) {
    return { applied: [] };
  }

  db.exec("PRAGMA foreign_keys=OFF;");
  const applied: string[] = [];
  for (const migration of pending) {
    db.transaction(() => {
      if (migration.hasExecutableSql) {
        db.exec(migration.sql);
      }
      db.recordMigration(migration);
    });
    applied.push(migration.name);
  }
  return { applied };
}

function randomMigrationId(): string {
  const globalCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (globalCrypto?.randomUUID) {
    return globalCrypto.randomUUID();
  }
  return createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 36);
}

/**
 * Open the runtime SQLite database with `bun:sqlite` and apply pending bundled
 * migrations. Only callable under the Bun runtime (the packaged desktop app).
 */
export async function migrateRuntimeDatabase(options: {
  databasePath: string;
  migrationsDir: string;
}): Promise<{ applied: string[] }> {
  const { Database } = (await import("bun:sqlite")) as typeof import("bun:sqlite");
  const bundled = collectBundledMigrations(options.migrationsDir);
  const sqlite = new Database(options.databasePath, { create: true });

  const db: RawSqliteDatabase = {
    exec: (sql) => sqlite.exec(sql),
    appliedMigrationNames: () => {
      const rows = sqlite
        .query(`SELECT migration_name FROM "_prisma_migrations" ORDER BY started_at ASC`)
        .all() as Array<{ migration_name: string }>;
      return rows
        .map((row) => row.migration_name)
        .filter((name): name is string => typeof name === "string" && name.length > 0);
    },
    recordMigration: (migration) => {
      sqlite
        .query(
          `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, applied_steps_count)
           VALUES (?, ?, current_timestamp, ?, 1)`,
        )
        .run(randomMigrationId(), migration.checksum, migration.name);
    },
    transaction: (run) => {
      sqlite.transaction(run)();
    },
    close: () => sqlite.close(),
  };

  try {
    return applyPendingMigrations(db, bundled);
  } finally {
    db.close();
  }
}
