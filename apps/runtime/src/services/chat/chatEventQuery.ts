import prismaClientPkg from "@prisma/client";
import type { ChatEventType as DbChatEventType, Prisma as PrismaNamespace, PrismaClient } from "@prisma/client";

const { Prisma } = prismaClientPkg as { Prisma: typeof import("@prisma/client").Prisma };

export type PersistedChatEventRow = {
  id: string;
  threadId: string;
  idx: number;
  type: DbChatEventType;
  payload: PrismaNamespace.JsonValue;
  createdAt: Date;
};

export async function listPersistedChatEventRows(
  prisma: PrismaClient,
  threadId: string,
  afterIdx?: number,
): Promise<PersistedChatEventRow[]> {
  return prisma.$queryRaw<PersistedChatEventRow[]>(Prisma.sql`
    SELECT id, threadId, idx, type, payload, createdAt
    FROM ChatEvent
    WHERE threadId = ${threadId}
    ${typeof afterIdx === "number" ? Prisma.sql`AND idx > ${afterIdx}` : Prisma.empty}
    ORDER BY idx ASC
  `);
}
