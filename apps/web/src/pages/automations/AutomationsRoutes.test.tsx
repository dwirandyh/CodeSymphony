import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("automations route tree", () => {
  it("registers both the index page and detail page beneath /automations", () => {
    const routeTree = readFileSync(resolve(process.cwd(), "src/routeTree.gen.ts"), "utf8");

    expect(routeTree).toContain('import { Route as AutomationsIndexRouteImport } from "./routes/automations.index"');
    expect(routeTree).toContain('"/automations/": typeof AutomationsIndexRoute');
    expect(routeTree).toContain('"/automations/$automationId": typeof AutomationsAutomationIdRoute');
    expect(routeTree).toContain("AutomationsIndexRoute: typeof AutomationsIndexRoute");
    expect(routeTree).toContain("AutomationsAutomationIdRoute: typeof AutomationsAutomationIdRoute");
  });
});
