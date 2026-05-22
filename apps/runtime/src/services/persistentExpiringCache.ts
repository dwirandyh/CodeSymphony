import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type PersistentExpiringCacheSnapshot<T> = {
  value: T;
  fetchedAt: string;
};

type PersistedSnapshotEnvelope<T> = PersistentExpiringCacheSnapshot<T> & {
  expiresAtMs: number;
  cacheVersion: string | null;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isValidPersistedSnapshotEnvelope<T>(
  value: unknown,
  validate: (candidate: unknown) => T,
): value is PersistedSnapshotEnvelope<T> {
  if (!isPlainObject(value)) {
    return false;
  }

  if (typeof value.fetchedAt !== "string" || !Number.isFinite(Date.parse(value.fetchedAt))) {
    return false;
  }

  if (!Number.isInteger(value.expiresAtMs) || Number(value.expiresAtMs) <= 0) {
    return false;
  }

  if (
    !("cacheVersion" in value)
    || (typeof value.cacheVersion !== "string" && value.cacheVersion !== null)
  ) {
    return false;
  }

  try {
    validate(value.value);
    return true;
  } catch {
    return false;
  }
}

export function createPersistentExpiringCache<T>(params: {
  ttlMs: number;
  storagePath: string;
  load: () => Promise<T>;
  validate: (candidate: unknown) => T;
  now?: () => number;
}) {
  const inflightByVersion = new Map<string, Promise<PersistentExpiringCacheSnapshot<T>>>();
  const now = params.now ?? (() => Date.now());

  function toCacheVersionKey(cacheVersion: string | null): string {
    return cacheVersion == null ? "__default__" : cacheVersion;
  }

  async function readPersistedSnapshot(): Promise<PersistedSnapshotEnvelope<T> | null> {
    try {
      const raw = await readFile(params.storagePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isValidPersistedSnapshotEnvelope(parsed, params.validate)) {
        return null;
      }

      return {
        value: params.validate(parsed.value),
        fetchedAt: parsed.fetchedAt,
        expiresAtMs: parsed.expiresAtMs,
        cacheVersion: parsed.cacheVersion,
      };
    } catch {
      return null;
    }
  }

  async function writePersistedSnapshot(snapshot: PersistedSnapshotEnvelope<T>): Promise<void> {
    await mkdir(path.dirname(params.storagePath), { recursive: true });
    await writeFile(params.storagePath, JSON.stringify(snapshot), "utf8");
  }

  async function loadFresh(cacheVersion: string | null): Promise<PersistentExpiringCacheSnapshot<T>> {
    const fetchedAtMs = now();
    const snapshot = {
      value: await params.load(),
      fetchedAt: new Date(fetchedAtMs).toISOString(),
      expiresAtMs: fetchedAtMs + params.ttlMs,
      cacheVersion,
    };
    await writePersistedSnapshot(snapshot);
    return {
      value: snapshot.value,
      fetchedAt: snapshot.fetchedAt,
    };
  }

  return {
    async get(options?: { refresh?: boolean; cacheVersion?: string | null }): Promise<PersistentExpiringCacheSnapshot<T>> {
      const cacheVersion = options?.cacheVersion ?? null;
      if (options?.refresh !== true) {
        const snapshot = await readPersistedSnapshot();
        if (snapshot && snapshot.cacheVersion === cacheVersion && now() < snapshot.expiresAtMs) {
          return {
            value: snapshot.value,
            fetchedAt: snapshot.fetchedAt,
          };
        }
      }

      const inflightKey = toCacheVersionKey(cacheVersion);
      const inflight = inflightByVersion.get(inflightKey);
      if (inflight) {
        return inflight;
      }

      const nextInflight = loadFresh(cacheVersion).finally(() => {
        if (inflightByVersion.get(inflightKey) === nextInflight) {
          inflightByVersion.delete(inflightKey);
        }
      });
      inflightByVersion.set(inflightKey, nextInflight);
      return nextInflight;
    },
    async clear(): Promise<void> {
      await rm(params.storagePath, { force: true });
    },
  };
}
