import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createModelProviderService } from "../src/services/modelProviderService";

const TEST_DATABASE_URL =
  process.env.DATABASE_URL && process.env.DATABASE_URL.includes("test.db")
    ? process.env.DATABASE_URL
    : "file:./prisma/test.db";

const prisma = new PrismaClient({
  datasources: { db: { url: TEST_DATABASE_URL } },
});

const service = createModelProviderService(prisma);

beforeEach(async () => {
  await prisma.modelProvider.deleteMany();
});

afterAll(async () => {
  await prisma.modelProvider.deleteMany();
  await prisma.$disconnect();
});

describe("modelProviderService", () => {
  describe("createProvider", () => {
    it("creates a new provider", async () => {
      const provider = await service.createProvider({
        name: "Test Provider",
        modelId: "gpt-4",
        baseUrl: "https://api.example.com",
        apiKey: "sk-test-key-1234567890",
      });
      expect(provider.name).toBe("Test Provider");
      expect(provider.modelId).toBe("gpt-4");
      expect(provider.baseUrl).toBe("https://api.example.com");
      expect(provider.apiKeyMasked).toBe("sk-test...7890");
      expect(provider.isActive).toBe(false);
    });

    it("masks short API keys", async () => {
      const provider = await service.createProvider({
        name: "Short",
        modelId: "gpt-4",
        baseUrl: "https://api.example.com",
        apiKey: "short",
      });
      expect(provider.apiKeyMasked).toBe("••••");
    });
  });

  describe("listProviders", () => {
    it("returns all providers ordered by creation", async () => {
      await service.createProvider({ name: "A", modelId: "m1", baseUrl: "http://a", apiKey: "key-a-1234567890123" });
      await service.createProvider({ name: "B", modelId: "m2", baseUrl: "http://b", apiKey: "key-b-1234567890123" });
      const providers = await service.listProviders();
      expect(providers.length).toBe(2);
      expect(providers[0].name).toBe("A");
      expect(providers[1].name).toBe("B");
    });
  });

  describe("updateProvider", () => {
    it("updates provider fields", async () => {
      const created = await service.createProvider({
        name: "Original",
        modelId: "m1",
        baseUrl: "http://old",
        apiKey: "key-original-12345678",
      });
      const updated = await service.updateProvider(created.id, { name: "Updated" });
      expect(updated.name).toBe("Updated");
      expect(updated.modelId).toBe("m1");
    });
  });

  describe("deleteProvider", () => {
    it("removes provider", async () => {
      const created = await service.createProvider({
        name: "ToDelete",
        modelId: "m1",
        baseUrl: "http://x",
        apiKey: "key-delete-1234567890",
      });
      await service.deleteProvider(created.id);
      const all = await service.listProviders();
      expect(all.length).toBe(0);
    });
  });

  describe("activateProvider", () => {
    it("activates provider and deactivates others", async () => {
      const a = await service.createProvider({ name: "A", modelId: "m1", baseUrl: "http://a", apiKey: "key-a-1234567890123" });
      const b = await service.createProvider({ name: "B", modelId: "m2", baseUrl: "http://b", apiKey: "key-b-1234567890123" });
      await service.activateProvider(a.id);
      await service.activateProvider(b.id);
      const providers = await service.listProviders();
      expect(providers.find(p => p.id === a.id)?.isActive).toBe(false);
      expect(providers.find(p => p.id === b.id)?.isActive).toBe(true);
    });
  });

  describe("deactivateAll", () => {
    it("deactivates all providers", async () => {
      const a = await service.createProvider({ name: "A", modelId: "m1", baseUrl: "http://a", apiKey: "key-a-1234567890123" });
      await service.activateProvider(a.id);
      await service.deactivateAll();
      const providers = await service.listProviders();
      expect(providers.every(p => !p.isActive)).toBe(true);
    });
  });

  describe("getActiveProvider", () => {
    it("returns null when none active", async () => {
      expect(await service.getActiveProvider()).toBeNull();
    });

    it("returns active provider with raw apiKey", async () => {
      const created = await service.createProvider({
        name: "Active",
        modelId: "m1",
        baseUrl: "http://api",
        apiKey: "sk-secret-1234567890",
      });
      await service.activateProvider(created.id);
      const active = await service.getActiveProvider();
      expect(active).not.toBeNull();
      expect(active!.apiKey).toBe("sk-secret-1234567890");
      expect(active!.name).toBe("Active");
    });
  });
});
