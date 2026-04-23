import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

class MockCodexChildProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  kill = vi.fn(() => {
    if (this.killed) {
      return true;
    }

    this.killed = true;
    queueMicrotask(() => {
      this.emit("exit", null, "SIGTERM");
    });
    return true;
  });
}

function attachJsonRpcServer(
  child: MockCodexChildProcess,
  options?: {
    methods?: string[];
    skillsListResult?: unknown;
    completeTurn?: boolean;
  },
) {
  let buffer = "";

  child.stdin.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      const message = JSON.parse(line) as { id?: string; method?: string };
      if (message.method) {
        options?.methods?.push(message.method);
      }

      if (message.method === "initialize") {
        child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        continue;
      }

      if (message.method === "skills/list") {
        child.stdout.write(`${JSON.stringify({
          id: message.id,
          result: options?.skillsListResult ?? { data: [] },
        })}\n`);
        continue;
      }

      if (message.method === "thread/start") {
        child.stdout.write(`${JSON.stringify({
          id: message.id,
          result: {
            thread: {
              id: "codex-thread-1",
            },
          },
        })}\n`);
        continue;
      }

      if (message.method === "turn/start") {
        child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        if (options?.completeTurn) {
          child.stdout.write(`${JSON.stringify({
            method: "turn/completed",
            params: {
              turn: {
                status: "completed",
              },
            },
          })}\n`);
        }
      }
    }
  });
}

describe("codex session runner skill integration", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("lists enabled slash commands from codex app-server skills", async () => {
    const child = new MockCodexChildProcess();
    attachJsonRpcServer(child, {
      skillsListResult: {
        data: [
          {
            cwd: "/tmp/project",
            errors: [],
            skills: [
              {
                name: "dogfood",
                description: "QA a web app",
                enabled: true,
              },
              {
                name: "Excel",
                description: "Spreadsheet work",
                enabled: false,
              },
              {
                name: "vercel-react-best-practices",
                description: "Long description",
                enabled: true,
                interface: {
                  shortDescription: "Repo skill",
                },
              },
            ],
          },
        ],
      },
    });

    const spawnMock = vi.fn(() => child);
    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
    }));

    const { listCodexSlashCommands } = await import("../src/codex/sessionRunner");
    const slashCommands = await listCodexSlashCommands({
      cwd: "/tmp/project",
    });

    expect(slashCommands).toEqual([
      { name: "dogfood", description: "QA a web app", argumentHint: "" },
      { name: "vercel-react-best-practices", description: "Repo skill", argumentHint: "" },
    ]);
    expect(spawnMock).toHaveBeenCalledWith(
      "codex",
      ["app-server"],
      expect.objectContaining({
        cwd: "/tmp/project",
      }),
    );
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("uses CLI config overrides for custom providers and refreshes skills before running a turn", async () => {
    const child = new MockCodexChildProcess();
    const methods: string[] = [];
    attachJsonRpcServer(child, {
      methods,
      completeTurn: true,
    });

    const spawnMock = vi.fn(() => child);
    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
    }));

    const { runCodexWithStreaming } = await import("../src/codex/sessionRunner");
    await runCodexWithStreaming({
      prompt: "Use $dogfood for this task.",
      sessionId: null,
      cwd: "/tmp/project",
      permissionMode: "default",
      threadPermissionMode: "default",
      model: "gpt-5.4",
      providerBaseUrl: "http://127.0.0.1:8317/v1",
      providerApiKey: "sk-test",
      onText: () => {},
      onToolStarted: () => {},
      onToolOutput: () => {},
      onToolFinished: () => {},
      onQuestionRequest: async () => ({ answers: {} }),
      onPermissionRequest: async () => ({ decision: "allow" }),
      onPlanFileDetected: () => {},
      onSubagentStarted: () => {},
      onSubagentStopped: () => {},
    });

    expect(methods).toEqual(["initialize", "initialized", "skills/list", "thread/start", "turn/start"]);

    const spawnArgs = spawnMock.mock.calls[0]?.[1] as string[];
    const spawnOptions = spawnMock.mock.calls[0]?.[2] as { env?: Record<string, string | undefined> };
    expect(spawnArgs).toEqual([
      "app-server",
      "-c",
      'model="gpt-5.4"',
      "-c",
      'model_provider="codesymphony_custom"',
      "-c",
      'model_providers.codesymphony_custom.base_url="http://127.0.0.1:8317/v1"',
      "-c",
      'model_providers.codesymphony_custom.wire_api="responses"',
      "-c",
      'model_providers.codesymphony_custom.env_key="CODESYMPHONY_CODEX_API_KEY"',
    ]);
    expect(spawnOptions.env?.CODESYMPHONY_CODEX_API_KEY).toBe("sk-test");
    expect(spawnOptions.env?.CODEX_HOME).toBe(process.env.CODEX_HOME);
  });
});
