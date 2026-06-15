import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAgentConfigService,
  getResolvedAgentConfigCached,
  resetResolvedAgentConfigCacheForTests,
} from "../src/services/agentConfigService";

const TEST_DATABASE_URL =
  process.env.DATABASE_URL && process.env.DATABASE_URL.includes("test.db")
    ? process.env.DATABASE_URL
    : "file:./test.db";

const prisma = new PrismaClient({
  datasources: { db: { url: TEST_DATABASE_URL } },
});

const service = createAgentConfigService(prisma);

beforeEach(async () => {
  await prisma.agentConfig.deleteMany();
  resetResolvedAgentConfigCacheForTests();
});

afterAll(async () => {
  await prisma.agentConfig.deleteMany();
  await prisma.$disconnect();
});

describe("agentConfigService", () => {
  it("returns empty defaults when no config row exists", async () => {
    const config = await service.getAgentConfig();
    expect(config.claudePath).toBeNull();
    expect(config.codexPath).toBeNull();
    expect(config.opencodePath).toBeNull();
    expect(config.cursorApiKeyMasked).toBe("");
    expect(config.cursorApiKeySet).toBe(false);
  });

  it("returns resolved paths reflecting config > env > default precedence", async () => {
    const empty = await service.getAgentConfig();
    // Resolved to an absolute path (via `which`) when found, else the bare command name.
    expect(empty.claudePathResolved === "claude" || empty.claudePathResolved.endsWith("/claude")).toBe(true);
    expect(empty.codexPathResolved === "codex" || empty.codexPathResolved.endsWith("/codex")).toBe(true);
    expect(empty.opencodePathResolved === "opencode" || empty.opencodePathResolved.endsWith("/opencode")).toBe(true);

    // An explicit path is returned verbatim (config takes precedence).
    const updated = await service.updateAgentConfig({ codexPath: "/custom/codex" });
    expect(updated.codexPathResolved).toBe("/custom/codex");
  });

  it("upserts the singleton row and returns masked cursor key", async () => {
    const updated = await service.updateAgentConfig({
      claudePath: "/usr/local/bin/claude",
      cursorApiKey: "cursor-secret-key-1234567890",
    });

    expect(updated.claudePath).toBe("/usr/local/bin/claude");
    expect(updated.cursorApiKeySet).toBe(true);
    expect(updated.cursorApiKeyMasked).toBe("cursor-...7890");

    const rows = await prisma.agentConfig.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("singleton");
    expect(rows[0]?.cursorApiKey).toBe("cursor-secret-key-1234567890");
  });

  it("leaves omitted fields unchanged and clears on empty string", async () => {
    await service.updateAgentConfig({
      claudePath: "/bin/claude",
      codexPath: "/bin/codex",
      cursorApiKey: "secret-key-abcdef",
    });

    const afterPartial = await service.updateAgentConfig({ codexPath: "/bin/codex2" });
    expect(afterPartial.claudePath).toBe("/bin/claude");
    expect(afterPartial.codexPath).toBe("/bin/codex2");
    expect(afterPartial.cursorApiKeySet).toBe(true);

    const cleared = await service.updateAgentConfig({ claudePath: "", cursorApiKey: "" });
    expect(cleared.claudePath).toBeNull();
    expect(cleared.cursorApiKeySet).toBe(false);
    expect(cleared.cursorApiKeyMasked).toBe("");
  });

  it("refreshes the sync cache so resolvers see new values without restart", async () => {
    expect(getResolvedAgentConfigCached()).toEqual({
      claudePath: null,
      codexPath: null,
      opencodePath: null,
      cursorApiKey: null,
    });

    await service.updateAgentConfig({
      claudePath: "/custom/claude",
      opencodePath: "/custom/opencode",
      cursorApiKey: "key-live-1234567890",
    });

    expect(getResolvedAgentConfigCached()).toEqual({
      claudePath: "/custom/claude",
      codexPath: null,
      opencodePath: "/custom/opencode",
      cursorApiKey: "key-live-1234567890",
    });
  });

  it("loads the cache from the DB at boot", async () => {
    await prisma.agentConfig.create({
      data: { id: "singleton", codexPath: "/boot/codex", updatedAt: new Date() },
    });

    expect(getResolvedAgentConfigCached().codexPath).toBeNull();
    await service.loadCache();
    expect(getResolvedAgentConfigCached().codexPath).toBe("/boot/codex");
  });
});
