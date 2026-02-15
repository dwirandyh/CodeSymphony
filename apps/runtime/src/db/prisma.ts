import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __codesymphonyPrisma: PrismaClient | undefined;
}

export const prisma = globalThis.__codesymphonyPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__codesymphonyPrisma = prisma;
}
