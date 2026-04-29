import { PrismaClient } from "@prisma/client";
import {
  buildTimelineSnapshot,
  mapEvents,
  mapMessages,
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
  messageCount: number;
  eventCount: number;
  newestSeq: number | null;
  newestIdx: number | null;
};

type SnapshotCaseSummary = {
  medianDurationMs: number;
  p95DurationMs: number;
  medianPayloadBytes: number;
  messageCount: number;
  eventCount: number;
  timelineItemsCount: number;
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

async function runThreadSnapshot(prisma: PrismaClient, threadId: string): Promise<SnapshotCaseResult> {
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
  });

  return {
    durationMs: round(performance.now() - startedAt),
    payloadBytes: toBytes(snapshot),
    timelineItemsCount: snapshot.timelineItems.length,
    messageCount: messageRows.length,
    eventCount: eventRows.length,
    newestSeq: snapshot.newestSeq,
    newestIdx: snapshot.newestIdx,
  };
}

function summarizeResults(results: SnapshotCaseResult[]): SnapshotCaseSummary {
  const lastResult = results.at(-1);

  return {
    medianDurationMs: round(median(results.map((result) => result.durationMs))),
    p95DurationMs: round(percentile(results.map((result) => result.durationMs), 0.95)),
    medianPayloadBytes: Math.round(median(results.map((result) => result.payloadBytes))),
    messageCount: lastResult?.messageCount ?? 0,
    eventCount: lastResult?.eventCount ?? 0,
    timelineItemsCount: lastResult?.timelineItemsCount ?? 0,
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

    console.log("# Thread Snapshot Benchmark");
    console.log(`runs=${args.runs} warmup=${args.warmup}`);
    console.log("");

    for (const thread of threads) {
      const results: SnapshotCaseResult[] = [];
      for (let runIndex = 0; runIndex < args.warmup + args.runs; runIndex += 1) {
        const result = await runThreadSnapshot(prisma, thread.threadId);
        if (runIndex >= args.warmup) {
          results.push(result);
        }
      }

      const summary = summarizeResults(results);
      console.log(`## ${thread.title}`);
      console.log(`threadId=${thread.threadId}`);
      console.log(`messages=${thread.messageCount} events=${thread.eventCount}`);
      console.log("");
      console.log(
        `median=${summary.medianDurationMs}ms p95=${summary.p95DurationMs}ms payload=${formatBytes(summary.medianPayloadBytes)} messages=${summary.messageCount} events=${summary.eventCount} timelineItems=${summary.timelineItemsCount}`,
      );
      console.log("");
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main();
