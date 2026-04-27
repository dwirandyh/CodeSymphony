import { PrismaClient } from "@prisma/client";
import {
  buildTimelineSnapshot,
  DISPLAY_TIMELINE_TAIL_EVENT_LIMIT,
  DISPLAY_TIMELINE_TAIL_MESSAGE_LIMIT,
  mapEvents,
  mapMessages,
  selectNewestRowsAscending,
} from "../services/chat/chatPaginationUtils.js";

type BenchmarkThread = {
  threadId: string;
  title: string;
  messageCount: number;
  eventCount: number;
};

type SnapshotCaseResult = {
  durationMs: number;
  payloadBytes: number;
  timelineItemsCount: number;
  selectedMessageCount: number;
  selectedEventCount: number;
  newestSeq: number | null;
  newestIdx: number | null;
  olderHistoryAvailable: boolean;
};

type SnapshotCaseSummary = {
  medianDurationMs: number;
  p95DurationMs: number;
  medianPayloadBytes: number;
  selectedMessageCount: number;
  selectedEventCount: number;
  timelineItemsCount: number;
  oldestRenderableHydrationPending: boolean;
};

type ParsedArgs = {
  threadIds: string[];
  runs: number;
  warmup: number;
  top: number;
};

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    threadIds: [],
    runs: 15,
    warmup: 3,
    top: 3,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--thread" && value) {
      parsed.threadIds.push(value);
      index += 1;
      continue;
    }

    if (arg === "--runs" && value) {
      parsed.runs = Number.parseInt(value, 10);
      index += 1;
      continue;
    }

    if (arg === "--warmup" && value) {
      parsed.warmup = Number.parseInt(value, 10);
      index += 1;
      continue;
    }

    if (arg === "--top" && value) {
      parsed.top = Number.parseInt(value, 10);
      index += 1;
    }
  }

  return parsed;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const targetIndex = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );

  return sorted[targetIndex] ?? 0;
}

function median(values: number[]): number {
  return percentile(values, 0.5);
}

function toBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

async function resolveBenchmarkThreads(prisma: PrismaClient, args: ParsedArgs): Promise<BenchmarkThread[]> {
  if (args.threadIds.length > 0) {
    const threads = await prisma.chatThread.findMany({
      where: {
        id: { in: args.threadIds },
      },
      select: {
        id: true,
        title: true,
        _count: {
          select: {
            messages: true,
            events: true,
          },
        },
      },
    });

    return args.threadIds.flatMap((threadId) => {
      const thread = threads.find((candidate) => candidate.id === threadId);
      if (!thread) {
        return [];
      }

      return [{
        threadId: thread.id,
        title: thread.title,
        messageCount: thread._count.messages,
        eventCount: thread._count.events,
      }];
    });
  }

  const topThreads = await prisma.chatThread.findMany({
    orderBy: {
      events: {
        _count: "desc",
      },
    },
    take: args.top,
    select: {
      id: true,
      title: true,
      _count: {
        select: {
          messages: true,
          events: true,
        },
      },
    },
  });

  return topThreads.map((thread) => ({
    threadId: thread.id,
    title: thread.title,
    messageCount: thread._count.messages,
    eventCount: thread._count.events,
  }));
}

async function runLegacyDisplaySnapshot(prisma: PrismaClient, threadId: string): Promise<SnapshotCaseResult> {
  const startedAt = performance.now();
  const [messageRows, eventRows] = await Promise.all([
    prisma.chatMessage.findMany({
      where: { threadId },
      orderBy: { seq: "asc" },
      include: { attachments: true },
    }),
    prisma.chatEvent.findMany({
      where: { threadId },
      orderBy: { idx: "asc" },
    }),
  ]);

  const snapshot = buildTimelineSnapshot({
    messages: mapMessages(messageRows),
    events: mapEvents(eventRows),
    threadId,
    includeCollections: false,
  });

  return {
    durationMs: round(performance.now() - startedAt),
    payloadBytes: toBytes(snapshot),
    timelineItemsCount: snapshot.timelineItems.length,
    selectedMessageCount: messageRows.length,
    selectedEventCount: eventRows.length,
    newestSeq: snapshot.newestSeq,
    newestIdx: snapshot.newestIdx,
    olderHistoryAvailable: false,
  };
}

async function runOptimizedDisplaySnapshot(prisma: PrismaClient, threadId: string): Promise<SnapshotCaseResult> {
  const startedAt = performance.now();
  const [messageRowsDescending, eventRowsDescending] = await Promise.all([
    prisma.chatMessage.findMany({
      where: { threadId },
      orderBy: { seq: "desc" },
      take: DISPLAY_TIMELINE_TAIL_MESSAGE_LIMIT + 1,
      include: { attachments: true },
    }),
    prisma.chatEvent.findMany({
      where: { threadId },
      orderBy: { idx: "desc" },
      take: DISPLAY_TIMELINE_TAIL_EVENT_LIMIT + 1,
    }),
  ]);

  const { rows: newestMessageRows, olderRowsAvailable: olderMessagesAvailable } = selectNewestRowsAscending(
    messageRowsDescending,
    DISPLAY_TIMELINE_TAIL_MESSAGE_LIMIT,
  );
  const { rows: newestEventRows, olderRowsAvailable: olderEventsAvailable } = selectNewestRowsAscending(
    eventRowsDescending,
    DISPLAY_TIMELINE_TAIL_EVENT_LIMIT,
  );
  const olderHistoryAvailable = olderMessagesAvailable || olderEventsAvailable;

  const snapshot = buildTimelineSnapshot({
    messages: mapMessages(newestMessageRows),
    events: mapEvents(newestEventRows),
    threadId,
    includeCollections: false,
    olderHistoryAvailable,
  });

  return {
    durationMs: round(performance.now() - startedAt),
    payloadBytes: toBytes(snapshot),
    timelineItemsCount: snapshot.timelineItems.length,
    selectedMessageCount: newestMessageRows.length,
    selectedEventCount: newestEventRows.length,
    newestSeq: snapshot.newestSeq,
    newestIdx: snapshot.newestIdx,
    olderHistoryAvailable,
  };
}

function summarizeResults(results: SnapshotCaseResult[]): SnapshotCaseSummary {
  const lastResult = results.at(-1);

  return {
    medianDurationMs: round(median(results.map((result) => result.durationMs))),
    p95DurationMs: round(percentile(results.map((result) => result.durationMs), 0.95)),
    medianPayloadBytes: Math.round(median(results.map((result) => result.payloadBytes))),
    selectedMessageCount: lastResult?.selectedMessageCount ?? 0,
    selectedEventCount: lastResult?.selectedEventCount ?? 0,
    timelineItemsCount: lastResult?.timelineItemsCount ?? 0,
    oldestRenderableHydrationPending: lastResult?.olderHistoryAvailable ?? false,
  };
}

async function benchmarkThread(prisma: PrismaClient, thread: BenchmarkThread, runs: number, warmup: number) {
  const legacyResults: SnapshotCaseResult[] = [];
  const optimizedResults: SnapshotCaseResult[] = [];
  const orderedCases = [
    { name: "legacy", run: runLegacyDisplaySnapshot },
    { name: "optimized", run: runOptimizedDisplaySnapshot },
  ] as const;

  for (let runIndex = 0; runIndex < warmup + runs; runIndex += 1) {
    const runOrder = runIndex % 2 === 0
      ? orderedCases
      : [orderedCases[1], orderedCases[0]] as const;

    for (const benchmarkCase of runOrder) {
      const result = await benchmarkCase.run(prisma, thread.threadId);
      if (runIndex < warmup) {
        continue;
      }

      if (benchmarkCase.name === "legacy") {
        legacyResults.push(result);
      } else {
        optimizedResults.push(result);
      }
    }
  }

  const legacy = summarizeResults(legacyResults);
  const optimized = summarizeResults(optimizedResults);

  return {
    legacy,
    optimized,
    durationImprovementPct: round(((legacy.medianDurationMs - optimized.medianDurationMs) / legacy.medianDurationMs) * 100),
    payloadImprovementPct: round(((legacy.medianPayloadBytes - optimized.medianPayloadBytes) / legacy.medianPayloadBytes) * 100),
  };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${round(bytes / (1024 * 1024))} MB`;
  }

  if (bytes >= 1024) {
    return `${round(bytes / 1024)} KB`;
  }

  return `${bytes} B`;
}

async function main() {
  const prisma = new PrismaClient();
  const args = parseArgs(process.argv.slice(2));

  try {
    const threads = await resolveBenchmarkThreads(prisma, args);

    if (threads.length === 0) {
      console.error("No benchmark threads found.");
      process.exitCode = 1;
      return;
    }

    console.log(`# Display Snapshot Benchmark`);
    console.log(`runs=${args.runs} warmup=${args.warmup}`);
    console.log(`tailMessageLimit=${DISPLAY_TIMELINE_TAIL_MESSAGE_LIMIT} tailEventLimit=${DISPLAY_TIMELINE_TAIL_EVENT_LIMIT}`);
    console.log("");

    for (const thread of threads) {
      const result = await benchmarkThread(prisma, thread, args.runs, args.warmup);

      console.log(`## ${thread.title}`);
      console.log(`threadId=${thread.threadId}`);
      console.log(`messages=${thread.messageCount} events=${thread.eventCount}`);
      console.log("");
      console.log(`legacy  median=${result.legacy.medianDurationMs}ms p95=${result.legacy.p95DurationMs}ms payload=${formatBytes(result.legacy.medianPayloadBytes)} selectedMessages=${result.legacy.selectedMessageCount} selectedEvents=${result.legacy.selectedEventCount} timelineItems=${result.legacy.timelineItemsCount}`);
      console.log(`optimized median=${result.optimized.medianDurationMs}ms p95=${result.optimized.p95DurationMs}ms payload=${formatBytes(result.optimized.medianPayloadBytes)} selectedMessages=${result.optimized.selectedMessageCount} selectedEvents=${result.optimized.selectedEventCount} timelineItems=${result.optimized.timelineItemsCount} hydrationPending=${result.optimized.oldestRenderableHydrationPending}`);
      console.log(`delta duration=-${result.durationImprovementPct}% payload=-${result.payloadImprovementPct}%`);
      console.log("");
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main();
