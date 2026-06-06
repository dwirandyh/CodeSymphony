import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createModelProviderService } from "../src/services/modelProviderService";

const TEST_DATABASE_URL =
  process.env.DATABASE_URL && process.env.DATABASE_URL.includes("test.db")
    ? process.env.DATABASE_URL
    : "file:./test.db";

const prisma = new PrismaClient({
  datasources: { db: { url: TEST_DATABASE_URL } },
});

const service = createModelProviderService(prisma);

function providerInput(overrides: Partial<Parameters<typeof service.createProvider>[0]> = {}) {
  return {
    name: "Test Provider",
    compatibility: "openai" as const,
    baseUrl: "https://api.example.com",
    apiKey: "sk-test-key-1234567890",
    models: [{ modelId: "gpt-4" }],
    ...overrides,
  };
}

beforeEach(async () => {
  await prisma.modelProvider.deleteMany();
});

afterAll(async () => {
  await prisma.modelProvider.deleteMany();
  await prisma.$disconnect();
});

describe("modelProviderService", () => {
  it("creates a provider with endpoint metadata and an initial model", async () => {
    const provider = await service.createProvider(providerInput());

    expect(provider.name).toBe("Test Provider");
    expect(provider).toMatchObject({
      compatibility: "openai",
      baseUrl: "https://api.example.com",
      apiKeyMasked: "sk-test...7890",
    });
    expect(provider.models).toHaveLength(1);
    expect(provider.models[0].modelId).toBe("gpt-4");
  });

  it("masks short API keys", async () => {
    const provider = await service.createProvider(providerInput({
      name: "Short",
      apiKey: "short",
    }));

    expect(provider.apiKeyMasked).toBe("••••");
  });

  it("returns providers ordered by creation", async () => {
    await service.createProvider(providerInput({ name: "A", models: [{ modelId: "m1" }] }));
    await service.createProvider(providerInput({ name: "B", models: [{ modelId: "m2" }] }));

    const providers = await service.listProviders();

    expect(providers.map((provider) => provider.name)).toEqual(["A", "B"]);
  });

  it("updates provider metadata and preserves the API key when omitted", async () => {
    const created = await service.createProvider(providerInput({ name: "Original" }));

    const updated = await service.updateProvider(created.id, {
      name: "Updated",
      baseUrl: "https://api.updated.example.com",
    });
    const resolved = await service.resolveProviderSelection(created.id, "gpt-4");

    expect(updated.name).toBe("Updated");
    expect(updated.baseUrl).toBe("https://api.updated.example.com");
    expect(resolved?.apiKey).toBe("sk-test-key-1234567890");
    expect(updated.models[0].modelId).toBe("gpt-4");
  });

  it("deletes provider and nested rows", async () => {
    const created = await service.createProvider(providerInput({ name: "ToDelete" }));

    await service.deleteProvider(created.id);

    expect(await service.listProviders()).toEqual([]);
    expect(await prisma.modelProviderModel.count()).toBe(0);
  });

  it("adds a second model without creating another provider", async () => {
    const created = await service.createProvider(providerInput());

    const updated = await service.createModel(created.id, { modelId: "gpt-4.1" });

    expect(updated.id).toBe(created.id);
    expect(updated.models.map((model) => model.modelId)).toEqual(["gpt-4", "gpt-4.1"]);
  });

  it("rejects duplicate model IDs inside one provider", async () => {
    await expect(service.createProvider(providerInput({
      models: [{ modelId: "gpt-4" }, { modelId: "gpt-4" }],
    }))).rejects.toThrow("Model IDs must be unique within a provider");

    const created = await service.createProvider(providerInput());

    await expect(service.createModel(created.id, { modelId: "gpt-4" }))
      .rejects.toThrow("Model ID already exists for this provider");
  });

  it("allows the same model ID in different providers", async () => {
    const first = await service.createProvider(providerInput({ name: "First" }));
    const second = await service.createProvider(providerInput({ name: "Second" }));

    expect(first.models[0].modelId).toBe("gpt-4");
    expect(second.models[0].modelId).toBe("gpt-4");
  });

  it("resolves a selected provider and model", async () => {
    const created = await service.createProvider(providerInput());

    const resolved = await service.resolveProviderSelection(created.id, "gpt-4");

    expect(resolved).toMatchObject({
      id: created.id,
      compatibility: "openai",
      apiKey: "sk-test-key-1234567890",
      baseUrl: "https://api.example.com",
      name: "Test Provider",
      modelId: "gpt-4",
    });
  });

  it("surfaces deleted provider or model selections as broken", async () => {
    const created = await service.createProvider(providerInput());
    const modelRowId = created.models[0].id;

    await service.deleteModel(modelRowId);
    await expect(service.resolveProviderSelection(created.id, "gpt-4"))
      .rejects.toThrow("Selected model is no longer available in this provider");

    await service.deleteProvider(created.id);
    expect(await service.resolveProviderSelection(created.id, "gpt-4")).toBeNull();
  });
});
