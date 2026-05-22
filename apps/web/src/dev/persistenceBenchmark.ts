import { createCollection, localStorageCollectionOptions } from "@tanstack/db";
import { debugLog } from "../lib/debugLog";
import {
  STARTUP_SHELL_SNAPSHOT_STORAGE_KEY,
  loadStartupShellSnapshot,
  saveStartupShellSnapshot,
  type StartupShellSnapshot,
} from "../lib/startupShellSnapshot";

type Summary = {
  iterations: number;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
};

type PersistenceBenchmarkResult = {
  generatedAt: string;
  userAgent: string;
  rawLocalStorageRead: Summary & {
    payloadBytes: number;
  };
  tanstackLocalStorageCreateRead: Summary & {
    payloadBytes: number;
  };
  startupSourceRead: Summary & {
    payloadBytes: number;
  };
};

declare global {
  interface Window {
    __CS_PERSISTENCE_BENCH__?: PersistenceBenchmarkResult;
  }
}

const RAW_STORAGE_KEY = "__cs_bench_raw_snapshot__";
const TANSTACK_LOCAL_STORAGE_KEY = "__cs_bench_tanstack_local_storage__";
const TANSTACK_LOCAL_STORAGE_COLLECTION_ID = "__cs_bench_tanstack_local_storage_collection__";
const TANSTACK_LOCAL_STORAGE_ROW_ID = "workspace-shell";
const RAW_READ_ITERATIONS = 500;
const TANSTACK_LOCAL_STORAGE_ITERATIONS = 120;
const STARTUP_SOURCE_READ_ITERATIONS = 500;

const SAMPLE_SNAPSHOT: StartupShellSnapshot = {
  version: 1,
  capturedAt: "2026-05-22T00:00:00.000Z",
  repoId: "cmnpiti0j07lbm97cytl5wgvw",
  repoName: "CodeSymphony",
  worktreeId: "cmnpiti0k07ldm97crnpfiq5w",
  worktreeBranch: "feat/instant-open",
  worktreePath: "/Users/dwirandyh/Work/Personal/codesymphony",
  worktreeStatus: "active",
  threadId: "cmob3mxfe0001m9v9lmtzq00m",
  threadTitle: "Instant open",
  threadStatus: "idle",
};

type WorkspaceShellStateRow = StartupShellSnapshot & {
  id: typeof TANSTACK_LOCAL_STORAGE_ROW_ID;
};

function getOutputNode() {
  const node = document.getElementById("output");
  if (!(node instanceof HTMLPreElement)) {
    throw new Error("Missing output node");
  }

  return node;
}

function renderOutput(value: unknown) {
  getOutputNode().textContent = JSON.stringify(value, null, 2);
}

function roundMetric(value: number) {
  return Math.round(value * 1000) / 1000;
}

function percentile(sortedValues: number[], ratio: number) {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * ratio) - 1),
  );
  return sortedValues[index] ?? 0;
}

function summarize(samples: number[]): Summary {
  const sortedValues = [...samples].sort((left, right) => left - right);
  const total = sortedValues.reduce((sum, value) => sum + value, 0);
  return {
    iterations: sortedValues.length,
    medianMs: roundMetric(percentile(sortedValues, 0.5)),
    p95Ms: roundMetric(percentile(sortedValues, 0.95)),
    minMs: roundMetric(sortedValues[0] ?? 0),
    maxMs: roundMetric(sortedValues[sortedValues.length - 1] ?? 0),
    avgMs: roundMetric(total / Math.max(sortedValues.length, 1)),
  };
}

function createStoredWorkspaceShellRow() {
  return {
    id: TANSTACK_LOCAL_STORAGE_ROW_ID,
    ...SAMPLE_SNAPSHOT,
  } satisfies WorkspaceShellStateRow;
}

function measureSyncIterations(iterations: number, fn: () => void) {
  const samples: number[] = [];

  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    fn();
    samples.push(performance.now() - startedAt);
  }

  return samples;
}

function benchmarkRawLocalStorageRead() {
  const serializedSnapshot = JSON.stringify(SAMPLE_SNAPSHOT);
  localStorage.setItem(RAW_STORAGE_KEY, serializedSnapshot);

  const samples = measureSyncIterations(RAW_READ_ITERATIONS, () => {
    const raw = localStorage.getItem(RAW_STORAGE_KEY);
    if (!raw) {
      throw new Error("Missing raw localStorage benchmark payload");
    }

    const parsed = JSON.parse(raw) as StartupShellSnapshot;
    if (parsed.threadId !== SAMPLE_SNAPSHOT.threadId) {
      throw new Error("Unexpected raw localStorage benchmark payload");
    }
  });

  localStorage.removeItem(RAW_STORAGE_KEY);

  return {
    ...summarize(samples),
    payloadBytes: serializedSnapshot.length,
  };
}

async function cleanupCollection(collection: { cleanup?: () => unknown }) {
  await Promise.resolve(collection.cleanup?.());
}

async function createTanStackLocalStoragePayloadTemplate() {
  const templateStorageKey = `${TANSTACK_LOCAL_STORAGE_KEY}:template`;
  const templateCollectionId = `${TANSTACK_LOCAL_STORAGE_COLLECTION_ID}:template`;
  localStorage.removeItem(templateStorageKey);

  const collection = createCollection(localStorageCollectionOptions<WorkspaceShellStateRow>({
    id: templateCollectionId,
    storageKey: templateStorageKey,
    getKey: (row) => row.id,
  }));
  collection.insert(createStoredWorkspaceShellRow());
  await Promise.resolve();

  const payload = localStorage.getItem(templateStorageKey);
  await cleanupCollection(collection as { cleanup?: () => unknown });
  localStorage.removeItem(templateStorageKey);

  if (!payload) {
    throw new Error("Unable to create TanStack localStorage benchmark payload");
  }

  return payload;
}

async function benchmarkTanStackLocalStorageCreateRead() {
  const samples: number[] = [];
  const payload = await createTanStackLocalStoragePayloadTemplate();
  const payloadBytes = payload.length;

  for (let index = 0; index < TANSTACK_LOCAL_STORAGE_ITERATIONS; index += 1) {
    const storageKey = `${TANSTACK_LOCAL_STORAGE_KEY}:${index}`;
    const collectionId = `${TANSTACK_LOCAL_STORAGE_COLLECTION_ID}:${index}`;
    localStorage.setItem(storageKey, payload);

    const startedAt = performance.now();
    const collection = createCollection(localStorageCollectionOptions<WorkspaceShellStateRow>({
      id: collectionId,
      storageKey,
      getKey: (row) => row.id,
    }));
    const readyRows = await (collection as {
      toArrayWhenReady: () => Promise<WorkspaceShellStateRow[]>;
    }).toArrayWhenReady();
    const row = readyRows[0] ?? null;
    if (!row || row.threadId !== SAMPLE_SNAPSHOT.threadId) {
      throw new Error(`Unexpected TanStack localStorage benchmark payload: ${JSON.stringify({
        row,
        storedPayload: localStorage.getItem(storageKey),
      })}`);
    }
    samples.push(performance.now() - startedAt);

    await cleanupCollection(collection as { cleanup?: () => unknown });
    localStorage.removeItem(storageKey);
  }

  return {
    ...summarize(samples),
    payloadBytes,
  };
}

function benchmarkStartupSourceRead() {
  saveStartupShellSnapshot(SAMPLE_SNAPSHOT);
  const storedPayload = window.localStorage.getItem(STARTUP_SHELL_SNAPSHOT_STORAGE_KEY);

  const readSamples = measureSyncIterations(STARTUP_SOURCE_READ_ITERATIONS, () => {
    const snapshot = loadStartupShellSnapshot();
    if (!snapshot || snapshot.threadId !== SAMPLE_SNAPSHOT.threadId) {
      throw new Error("Unexpected startup source benchmark snapshot");
    }
  });
  saveStartupShellSnapshot(null);

  return {
    ...summarize(readSamples),
    payloadBytes: storedPayload?.length ?? 0,
  };
}

async function runBenchmark() {
  saveStartupShellSnapshot(null);
  localStorage.removeItem(RAW_STORAGE_KEY);

  const result: PersistenceBenchmarkResult = {
    generatedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    rawLocalStorageRead: benchmarkRawLocalStorageRead(),
    tanstackLocalStorageCreateRead: await benchmarkTanStackLocalStorageCreateRead(),
    startupSourceRead: benchmarkStartupSourceRead(),
  };

  window.__CS_PERSISTENCE_BENCH__ = result;
  renderOutput(result);
  debugLog("persistence.bench", "startup-first-frame-compare", result, { force: true });
}

void runBenchmark().catch((error) => {
  const payload = {
    message: error instanceof Error ? error.message : String(error),
  };
  renderOutput({ error: payload.message });
  debugLog("persistence.bench", "startup-first-frame-compare.failed", payload, { force: true });
});
