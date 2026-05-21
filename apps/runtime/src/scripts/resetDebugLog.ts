import { writeFileSync } from "node:fs";
import { resolveDebugLogPath } from "./startupMetricsShared.js";

type ParsedArgs = {
  runtimeUrl: string | null;
};

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    runtimeUrl: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--runtime-url" && value) {
      parsed.runtimeUrl = value.replace(/\/+$/u, "");
      index += 1;
    }
  }

  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.runtimeUrl) {
    const response = await fetch(`${args.runtimeUrl}/debug/log-buffer/reset`, {
      method: "POST",
    });

    if (!response.ok) {
      throw new Error(`Failed to reset runtime debug log via ${args.runtimeUrl}: ${response.status}`);
    }

    const payload = await response.json() as {
      clearedEntries?: number;
    };
    console.log(`Reset runtime debug log via ${args.runtimeUrl} (cleared ${payload.clearedEntries ?? 0} entries)`);
    return;
  }

  const logPath = resolveDebugLogPath();
  writeFileSync(logPath, "", "utf-8");
  console.log(`Reset debug log: ${logPath}`);
}

void main();
