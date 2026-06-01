import prismaClientPkg from "@prisma/client";
import type { PrismaClient as PrismaClientType } from "@prisma/client";

const { PrismaClient } = prismaClientPkg as {
  PrismaClient: new (...args: any[]) => PrismaClientType;
};

declare global {
  // eslint-disable-next-line no-var
  var __codesymphonyPrisma: PrismaClientType | undefined;
}

export const prisma = globalThis.__codesymphonyPrisma ?? new PrismaClient();

const nodeEnvKey = ["NODE", "ENV"].join("_");
if (process.env[nodeEnvKey] !== "production") {
  globalThis.__codesymphonyPrisma = prisma;
}
