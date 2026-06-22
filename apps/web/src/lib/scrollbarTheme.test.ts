import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesPath = join(dirname(fileURLToPath(import.meta.url)), "../styles.css");

describe("scrollbarTheme", () => {
  it("defines global thin scrollbar styling in the base layer", () => {
    const styles = readFileSync(stylesPath, "utf8");

    expect(styles).toContain("@layer base");
    expect(styles).toContain("scrollbar-width: thin");
    expect(styles).toContain("scrollbar-color:");
    expect(styles).toContain("::-webkit-scrollbar");
    expect(styles).toContain("::-webkit-scrollbar-thumb");
  });
});