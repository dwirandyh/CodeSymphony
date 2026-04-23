import type { PrismaClient } from "@prisma/client";

export class DatabaseNotReadyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DatabaseNotReadyError";
  }
}

function isPrismaSchemaNotReadyError(error: unknown): error is { code: string; meta?: Record<string, unknown> } {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  return code === "P2021" || code === "P2022";
}

function describeSchemaError(error: { code: string; meta?: Record<string, unknown> }): string {
  if (error.code === "P2021") {
    const table = typeof error.meta?.table === "string" ? error.meta.table : "the required table";
    return `${table} is missing`;
  }

  if (error.code === "P2022") {
    const column = typeof error.meta?.column === "string" ? error.meta.column : "a required column";
    return `${column} is missing`;
  }

  return "the database schema is not ready";
}

export async function assertDatabaseReady(prisma: PrismaClient): Promise<void> {
  try {
    await prisma.chatThread.findFirst({
      select: {
        id: true,
        mode: true,
        claudeSessionId: true,
        codexSessionId: true,
        opencodeSessionId: true,
      },
    });
  } catch (error) {
    if (isPrismaSchemaNotReadyError(error)) {
      throw new DatabaseNotReadyError(
        `Runtime database schema is not initialized or is out of date: ${describeSchemaError(error)}. Run \`pnpm db:migrate\` before starting the runtime.`,
        { cause: error },
      );
    }

    throw error;
  }
}
