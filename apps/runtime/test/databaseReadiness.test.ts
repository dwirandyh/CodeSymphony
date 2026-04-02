import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { assertDatabaseReady, DatabaseNotReadyError } from "../src/db/databaseReadiness";

describe("assertDatabaseReady", () => {
  it("accepts a migrated database", async () => {
    const prisma = {
      chatThread: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    } as unknown as PrismaClient;

    await expect(assertDatabaseReady(prisma)).resolves.toBeUndefined();
  });

  it("throws a clear error when the chat thread table is missing", async () => {
    const prisma = {
      chatThread: {
        findFirst: vi.fn().mockRejectedValue({
          code: "P2021",
          meta: { table: "main.ChatThread" },
        }),
      },
    } as unknown as PrismaClient;

    await expect(assertDatabaseReady(prisma)).rejects.toThrow(DatabaseNotReadyError);
    await expect(assertDatabaseReady(prisma)).rejects.toThrow(
      "Run `pnpm db:migrate` before starting the runtime.",
    );
  });

  it("throws a clear error when a required column is missing", async () => {
    const prisma = {
      chatThread: {
        findFirst: vi.fn().mockRejectedValue({
          code: "P2022",
          meta: { column: "main.ChatThread.mode" },
        }),
      },
    } as unknown as PrismaClient;

    await expect(assertDatabaseReady(prisma)).rejects.toThrow(DatabaseNotReadyError);
    await expect(assertDatabaseReady(prisma)).rejects.toThrow("main.ChatThread.mode is missing");
  });
});
