const registeredModelCatalogCaches: Array<{ clear: () => Promise<void> }> = [];

export function registerModelCatalogCaches(
  caches: Array<{ clear: () => Promise<void> }>,
): void {
  registeredModelCatalogCaches.length = 0;
  registeredModelCatalogCaches.push(...caches);
}

export async function clearRegisteredModelCatalogCaches(): Promise<void> {
  await Promise.all(registeredModelCatalogCaches.map((cache) => cache.clear()));
}