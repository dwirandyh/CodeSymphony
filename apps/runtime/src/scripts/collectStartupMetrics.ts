import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  formatMetricValue,
  median,
  percentile,
  resolveDebugLogPath,
  round,
  STARTUP_METRIC_ORDER,
  type StartupMetricEntry,
  type StartupMetricId,
  type StartupScenarioId,
  type StartupSessionSummary,
  type StartupTarget,
} from "./startupMetricsShared.js";

type ParsedArgs = {
  logPath: string;
  latest: boolean;
  outputPath: string | null;
  runtimeUrl: string | null;
  scenario: StartupScenarioId | null;
  sessionId: string | null;
  target: StartupTarget | null;
};

function findWorkspaceBundleAsset(distAssetsDir: string) {
  if (!existsSync(distAssetsDir)) {
    return null;
  }

  const assetFiles = readdirSync(distAssetsDir).filter((file) => file.endsWith(".js"));
  const namedChunk = assetFiles.find((file) => /^WorkspacePage-.*\.js$/u.test(file));
  if (namedChunk) {
    return path.join(distAssetsDir, namedChunk);
  }

  return assetFiles.find((file) => {
    const source = readFileSync(path.join(distAssetsDir, file), "utf-8");
    return source.includes("Loading workspace shell...");
  }) ?? null;
}

function measureWorkspaceBundleMetric(): StartupMetricEntry | null {
  const candidateAssetDirs = [
    path.resolve(process.cwd(), "../web/dist/assets"),
    path.resolve(process.cwd(), "../desktop/electron/runtime-bundle/dist/assets"),
  ];

  for (const distAssetsDir of candidateAssetDirs) {
    const matchedAsset = findWorkspaceBundleAsset(distAssetsDir);
    if (!matchedAsset) {
      continue;
    }

    const assetPath = path.isAbsolute(matchedAsset)
      ? matchedAsset
      : path.join(distAssetsDir, matchedAsset);
    const source = readFileSync(assetPath);
    const gzipBytes = gzipSync(source).byteLength;
    const gzipKb = round(gzipBytes / 1000);

    return {
      metricId: "bundle.workspace_page_gzip_kb",
      unit: "kb",
      value: gzipKb,
      sessionId: "bundle-measurement",
      target: "unknown",
      scenario: "unknown",
      persistedStateExpected: false,
      emittedAtMs: 0,
      data: {
        assetPath,
        gzipBytes,
      },
    };
  }

  return null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    logPath: resolveDebugLogPath(),
    latest: false,
    outputPath: null,
    runtimeUrl: null,
    scenario: null,
    sessionId: null,
    target: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--log-path" && value) {
      parsed.logPath = value;
      index += 1;
      continue;
    }

    if (arg === "--target" && value) {
      if (value === "web" || value === "desktop" || value === "unknown") {
        parsed.target = value;
      }
      index += 1;
      continue;
    }

    if (arg === "--runtime-url" && value) {
      parsed.runtimeUrl = value.replace(/\/+$/u, "");
      index += 1;
      continue;
    }

    if (arg === "--scenario" && value) {
      if (
        value === "cold-empty"
        || value === "warm-persisted"
        || value === "warm-runtime-delayed"
        || value === "unknown"
      ) {
        parsed.scenario = value;
      }
      index += 1;
      continue;
    }

    if (arg === "--session" && value) {
      parsed.sessionId = value;
      index += 1;
      continue;
    }

    if (arg === "--latest") {
      parsed.latest = true;
      continue;
    }

    if (arg === "--write" && value) {
      parsed.outputPath = value;
      index += 1;
    }
  }

  return parsed;
}

function parseStartupLogLine(line: string): {
  message: string;
  payload: Record<string, unknown>;
} | null {
  const match = /^#\d+ \[[^\]]+\] startup\.perf \| ([^|]+) \| (.+)$/u.exec(line.trim());
  if (!match) {
    return null;
  }

  try {
    const payload = JSON.parse(match[2] ?? "null") as Record<string, unknown> | null;
    if (!payload || typeof payload !== "object") {
      return null;
    }

    return {
      message: (match[1] ?? "").trim(),
      payload,
    };
  } catch {
    return null;
  }
}

function toStartupMetricEntry(payload: Record<string, unknown>): StartupMetricEntry | null {
  const metricId = payload.metricId;
  const unit = payload.unit;
  const value = payload.value;
  const sessionId = payload.sessionId;
  const target = payload.target;
  const scenario = payload.scenario;

  if (
    typeof metricId !== "string"
    || !STARTUP_METRIC_ORDER.includes(metricId as StartupMetricId)
    || (unit !== "ms" && unit !== "bytes" && unit !== "kb")
    || typeof value !== "number"
    || typeof sessionId !== "string"
    || (target !== "web" && target !== "desktop" && target !== "unknown")
    || (
      scenario !== "cold-empty"
      && scenario !== "warm-persisted"
      && scenario !== "warm-runtime-delayed"
      && scenario !== "unknown"
    )
  ) {
    return null;
  }

  return {
    metricId: metricId as StartupMetricId,
    unit,
    value,
    sessionId,
    target,
    scenario,
    persistedStateExpected: payload.persistedStateExpected === true,
    emittedAtMs: typeof payload.emittedAtMs === "number" ? payload.emittedAtMs : 0,
    data:
      payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
        ? payload.data as Record<string, unknown>
        : null,
  };
}

function readSessions(args: ParsedArgs): StartupSessionSummary[] {
  const rawEntries = args.runtimeUrl == null
    ? readFileSync(args.logPath, "utf-8").split("\n").flatMap((line) => {
      const parsed = parseStartupLogLine(line);
      return parsed ? [parsed] : [];
    })
    : [];
  const sessions = new Map<string, StartupSessionSummary>();

  for (const parsed of rawEntries) {

    if (parsed.message === "startup.session.started") {
      const sessionId = typeof parsed.payload.sessionId === "string" ? parsed.payload.sessionId : null;
      if (!sessionId) {
        continue;
      }

      sessions.set(sessionId, {
        sessionId,
        target: parsed.payload.target === "web" || parsed.payload.target === "desktop" || parsed.payload.target === "unknown"
          ? parsed.payload.target
          : "unknown",
        scenario:
          parsed.payload.scenario === "cold-empty"
          || parsed.payload.scenario === "warm-persisted"
          || parsed.payload.scenario === "warm-runtime-delayed"
          || parsed.payload.scenario === "unknown"
            ? parsed.payload.scenario
            : "unknown",
        persistedStateExpected: parsed.payload.persistedStateExpected === true,
        startedAtMs: typeof parsed.payload.ts === "number" ? parsed.payload.ts : null,
        metrics: {},
      });
      continue;
    }

    const metricEntry = toStartupMetricEntry(parsed.payload);
    if (!metricEntry) {
      continue;
    }

    const current = sessions.get(metricEntry.sessionId) ?? {
      sessionId: metricEntry.sessionId,
      target: metricEntry.target,
      scenario: metricEntry.scenario,
      persistedStateExpected: metricEntry.persistedStateExpected,
      startedAtMs: null,
      metrics: {},
    };
    current.target = metricEntry.target;
    current.scenario = metricEntry.scenario;
    current.persistedStateExpected = metricEntry.persistedStateExpected;
    current.metrics[metricEntry.metricId] = metricEntry;
    sessions.set(metricEntry.sessionId, current);
  }

  let results = Array.from(sessions.values());

  if (args.target) {
    results = results.filter((session) => session.target === args.target);
  }

  if (args.scenario) {
    results = results.filter((session) => session.scenario === args.scenario);
  }

  if (args.sessionId) {
    results = results.filter((session) => session.sessionId === args.sessionId);
  }

  results.sort((left, right) => {
    const leftReady = left.metrics["startup.shell_visible_ms"]?.emittedAtMs ?? -1;
    const rightReady = right.metrics["startup.shell_visible_ms"]?.emittedAtMs ?? -1;
    return leftReady - rightReady;
  });

  if (args.latest && results.length > 0) {
    return [results.at(-1)!];
  }

  return results;
}

async function readSessionsFromRuntime(args: ParsedArgs): Promise<StartupSessionSummary[]> {
  if (!args.runtimeUrl) {
    return readSessions(args);
  }

  const response = await fetch(`${args.runtimeUrl}/debug/log-buffer?source=startup.perf&limit=4000`);
  if (!response.ok) {
    throw new Error(`Failed to fetch startup logs from ${args.runtimeUrl}: ${response.status}`);
  }

  const payload = await response.json() as {
    data?: {
      entries?: Array<{
        source: string;
        message: string;
        data: Record<string, unknown>;
      }>;
      logPath?: string;
    };
  };

  const sessions = new Map<string, StartupSessionSummary>();
  const entries = payload.data?.entries ?? [];

  for (const parsed of entries.map((entry) => ({
    message: entry.message,
    payload: entry.data,
  }))) {
    if (!parsed.payload || typeof parsed.payload !== "object") {
      continue;
    }

    if (parsed.message === "startup.session.started") {
      const sessionId = typeof parsed.payload.sessionId === "string" ? parsed.payload.sessionId : null;
      if (!sessionId) {
        continue;
      }

      sessions.set(sessionId, {
        sessionId,
        target: parsed.payload.target === "web" || parsed.payload.target === "desktop" || parsed.payload.target === "unknown"
          ? parsed.payload.target
          : "unknown",
        scenario:
          parsed.payload.scenario === "cold-empty"
          || parsed.payload.scenario === "warm-persisted"
          || parsed.payload.scenario === "warm-runtime-delayed"
          || parsed.payload.scenario === "unknown"
            ? parsed.payload.scenario
            : "unknown",
        persistedStateExpected: parsed.payload.persistedStateExpected === true,
        startedAtMs: null,
        metrics: {},
      });
      continue;
    }

    const metricEntry = toStartupMetricEntry(parsed.payload);
    if (!metricEntry) {
      continue;
    }

    const current = sessions.get(metricEntry.sessionId) ?? {
      sessionId: metricEntry.sessionId,
      target: metricEntry.target,
      scenario: metricEntry.scenario,
      persistedStateExpected: metricEntry.persistedStateExpected,
      startedAtMs: null,
      metrics: {},
    };
    current.target = metricEntry.target;
    current.scenario = metricEntry.scenario;
    current.persistedStateExpected = metricEntry.persistedStateExpected;
    current.metrics[metricEntry.metricId] = metricEntry;
    sessions.set(metricEntry.sessionId, current);
  }

  let results = Array.from(sessions.values());

  if (args.target) {
    results = results.filter((session) => session.target === args.target);
  }

  if (args.scenario) {
    results = results.filter((session) => session.scenario === args.scenario);
  }

  if (args.sessionId) {
    results = results.filter((session) => session.sessionId === args.sessionId);
  }

  results.sort((left, right) => {
    const leftReady = left.metrics["startup.shell_visible_ms"]?.emittedAtMs ?? -1;
    const rightReady = right.metrics["startup.shell_visible_ms"]?.emittedAtMs ?? -1;
    return leftReady - rightReady;
  });

  if (args.latest && results.length > 0) {
    return [results.at(-1)!];
  }

  return results;
}

function renderMarkdownReport(args: ParsedArgs, sessions: StartupSessionSummary[]): string {
  const lines: string[] = [];
  const bundleMetric = measureWorkspaceBundleMetric();
  lines.push("# Startup Metrics Report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(args.runtimeUrl == null
    ? `Log path: \`${args.logPath}\``
    : `Runtime log source: \`${args.runtimeUrl}/debug/log-buffer?source=startup.perf\``);
  lines.push(`Sessions: ${sessions.length}`);
  lines.push(`Filters: target=${args.target ?? "*"}, scenario=${args.scenario ?? "*"}, session=${args.sessionId ?? (args.latest ? "latest" : "*")}`);
  lines.push("");

  if (sessions.length === 0) {
    lines.push("No startup sessions matched the current filters.");
    return lines.join("\n");
  }

  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Runs | Median | p95 | Missing |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");

  for (const metricId of STARTUP_METRIC_ORDER) {
    const metricEntries = sessions
      .map((session) => session.metrics[metricId] ?? null)
      .filter((entry): entry is StartupMetricEntry => entry !== null);
    if (metricId === "bundle.workspace_page_gzip_kb" && metricEntries.length === 0 && bundleMetric) {
      lines.push(
        `| \`${metricId}\` | 1 | ${formatMetricValue(bundleMetric.value, bundleMetric.unit)} | ${formatMetricValue(bundleMetric.value, bundleMetric.unit)} | 0 |`,
      );
      continue;
    }

    if (metricEntries.length === 0) {
      lines.push(`| \`${metricId}\` | 0 | - | - | ${sessions.length} |`);
      continue;
    }

    const values = metricEntries.map((entry) => entry.value);
    const unit = metricEntries[0]!.unit;
    lines.push(
      `| \`${metricId}\` | ${metricEntries.length} | ${formatMetricValue(median(values), unit)} | ${formatMetricValue(percentile(values, 0.95), unit)} | ${sessions.length - metricEntries.length} |`,
    );
  }

  lines.push("");
  lines.push("## Per Run");
  lines.push("");
  lines.push("| Session | Target | Scenario | Persisted | shell | workspace | thread shell | timeline | runtime | live | blank | payload |");
  lines.push("| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");

  for (const session of sessions) {
    const metric = (metricId: StartupMetricId) => session.metrics[metricId];
    lines.push([
      `| \`${session.sessionId.slice(0, 8)}\``,
      session.target,
      session.scenario,
      session.persistedStateExpected ? "yes" : "no",
      metric("startup.shell_visible_ms") ? formatMetricValue(metric("startup.shell_visible_ms")!.value, "ms") : "-",
      metric("startup.selected_workspace_ready_ms") ? formatMetricValue(metric("startup.selected_workspace_ready_ms")!.value, "ms") : "-",
      metric("startup.selected_thread_shell_ready_ms") ? formatMetricValue(metric("startup.selected_thread_shell_ready_ms")!.value, "ms") : "-",
      metric("startup.selected_thread_timeline_ready_ms") ? formatMetricValue(metric("startup.selected_thread_timeline_ready_ms")!.value, "ms") : "-",
      metric("startup.runtime_connected_ms") ? formatMetricValue(metric("startup.runtime_connected_ms")!.value, "ms") : "-",
      metric("startup.live_connected_ms") ? formatMetricValue(metric("startup.live_connected_ms")!.value, "ms") : "-",
      metric("startup.blank_screen_ms") ? formatMetricValue(metric("startup.blank_screen_ms")!.value, "ms") : "-",
      metric("startup.bootstrap_payload_bytes") ? formatMetricValue(metric("startup.bootstrap_payload_bytes")!.value, "bytes") : "-",
      "|",
    ].join(" | "));
  }

  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push("- `startup.bootstrap_payload_bytes` reflects dedicated startup bootstrap contract requests tracked before workspace/thread readiness settles.");
  lines.push("- `startup.live_connected_ms` currently uses the workspace sync websocket open event as the first live-health signal.");
  if (bundleMetric?.data?.assetPath && typeof bundleMetric.data.assetPath === "string") {
    lines.push(`- \`bundle.workspace_page_gzip_kb\` is measured directly from \`${bundleMetric.data.assetPath}\`.`);
  }

  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sessions = await readSessionsFromRuntime(args);
  const report = renderMarkdownReport(args, sessions);

  if (args.outputPath) {
    writeFileSync(args.outputPath, report, "utf-8");
  }

  console.log(report);
}

void main();
