import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type PersistentExpiringCacheSnapshot<T> = {
  value: T;
  fetchedAt: string;
};

type PersistedSnapshotEnvelope<T> = PersistentExpiringCacheSnapshot<T> & {
  expiresAtMs: number;
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
  let inflight: Promise<PersistentExpiringCacheSnapshot<T>> | null = null;
  const now = params.now ?? (() => Date.now());

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
      };
    } catch {
      return null;
    }
  }

  async function writePersistedSnapshot(snapshot: PersistedSnapshotEnvelope<T>): Promise<void> {
    await mkdir(path.dirname(params.storagePath), { recursive: true });
    await writeFile(params.storagePath, JSON.stringify(snapshot), "utf8");
  }

  async function loadFresh(): Promise<PersistentExpiringCacheSnapshot<T>> {
    const fetchedAtMs = now();
    const snapshot = {
      value: await params.load(),
      fetchedAt: new Date(fetchedAtMs).toISOString(),
      expiresAtMs: fetchedAtMs + params.ttlMs,
    };
    await writePersistedSnapshot(snapshot);
    return {
      value: snapshot.value,
      fetchedAt: snapshot.fetchedAt,
    };
  }

  return {
    async get(options?: { refresh?: boolean }): Promise<PersistentExpiringCacheSnapshot<T>> {
      if (options?.refresh !== true) {
        const snapshot = await readPersistedSnapshot();
        if (snapshot && now() < snapshot.expiresAtMs) {
          return {
            value: snapshot.value,
            fetchedAt: snapshot.fetchedAt,
          };
        }
      }

      if (!inflight) {
        inflight = loadFresh().finally(() => {
          inflight = null;
        });
      }

      return inflight;
    },
    async clear(): Promise<void> {
      await rm(params.storagePath, { force: true });
    },
  };
}
