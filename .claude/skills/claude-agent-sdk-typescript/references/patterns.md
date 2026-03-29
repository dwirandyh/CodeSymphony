# Claude Agent SDK TypeScript Patterns

These snippets are meant to be adapted, not pasted blindly. They match the installed SDK shape in this repo.

## 1. Basic Node query loop

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Summarize this repository",
  options: {
    cwd: process.cwd(),
    tools: { type: "preset", preset: "claude_code" },
    allowedTools: ["Read", "Glob", "Grep"],
    permissionMode: "default",
    settingSources: ["project", "local", "user"],
  },
})) {
  if (message.type === "assistant") {
    // inspect message.message.content if you need raw assistant blocks
  }

  if (message.type === "result" && message.subtype === "success") {
    console.log(message.result);
  }
}
```

Use this shape when the app mainly needs a final answer plus ordinary built-in tools.

## 2. Handling partial stream events

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Explain the auth system while you work",
  options: {
    cwd: process.cwd(),
    tools: { type: "preset", preset: "claude_code" },
    includePartialMessages: true,
  },
})) {
  if (message.type === "stream_event") {
    // BetaRawMessageStreamEvent from the underlying model stream
    console.log(message.event.type);
  }

  if (message.type === "result") {
    console.log(message.subtype, message.duration_ms, message.total_cost_usd);
  }
}
```

Only enable partials if the caller actually needs them.

## 3. Centralized permission policy with `canUseTool`

```ts
import { query, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";

const canUseTool = async (
  toolName: string,
  input: Record<string, unknown>,
): Promise<PermissionResult> => {
  if (toolName === "Bash") {
    const command = String(input.command ?? "");
    if (command.includes("rm -rf")) {
      return {
        behavior: "deny",
        message: "Destructive deletes are not allowed from this workflow.",
      };
    }
  }

  if (toolName === "Read" || toolName === "Glob" || toolName === "Grep") {
    return { behavior: "allow" };
  }

  return {
    behavior: "deny",
    message: `Tool ${toolName} is not approved in this flow.`,
  };
};

for await (const message of query({
  prompt: "Inspect the repository",
  options: {
    cwd: process.cwd(),
    tools: { type: "preset", preset: "claude_code" },
    permissionMode: "default",
    canUseTool,
  },
})) {
  if (message.type === "result") console.log(message.result);
}
```

Use `canUseTool` for app policy. Use hooks when you also need lifecycle observability.

## 4. Hooking tool lifecycle events

```ts
import { query, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync } from "node:fs";

const logToolUse: HookCallback = async (input) => {
  const hookInput = input as {
    hook_event_name: string;
    tool_name?: string;
    tool_use_id?: string;
  };

  appendFileSync(
    "./agent-audit.log",
    `${new Date().toISOString()} ${hookInput.hook_event_name} ${hookInput.tool_name ?? ""} ${hookInput.tool_use_id ?? ""}\n`,
  );

  return {};
};

for await (const message of query({
  prompt: "Refactor the utility module",
  options: {
    cwd: process.cwd(),
    allowedTools: ["Read", "Edit", "Write"],
    permissionMode: "acceptEdits",
    hooks: {
      PreToolUse: [{ hooks: [logToolUse] }],
      PostToolUse: [{ hooks: [logToolUse] }],
      PostToolUseFailure: [{ hooks: [logToolUse] }],
    },
  },
})) {
  if (message.type === "result") console.log(message.result);
}
```

## 5. In-process MCP tools with `tool()` and `createSdkMcpServer()`

```ts
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const lookupTicket = tool(
  "lookup-ticket",
  "Look up ticket details by ID",
  { ticketId: z.string() },
  async ({ ticketId }) => ({
    content: [{ type: "text", text: `Ticket ${ticketId}: open, high priority` }],
  }),
);

const internalTools = createSdkMcpServer({
  name: "internal-tools",
  version: "1.0.0",
  tools: [lookupTicket],
});

for await (const message of query({
  prompt: "Check ticket CS-142 and summarize it",
  options: {
    cwd: process.cwd(),
    mcpServers: {
      internal: internalTools,
    },
  },
})) {
  if (message.type === "result") console.log(message.result);
}
```

Prefer this over a separate MCP process when the tool code already lives in the Node app.

## 6. Subagents

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Use the test-runner agent to run the relevant tests",
  options: {
    cwd: process.cwd(),
    allowedTools: ["Read", "Glob", "Grep", "Bash", "Agent"],
    agentProgressSummaries: true,
    agents: {
      "test-runner": {
        description: "Runs focused test commands and reports failures.",
        prompt: "Run relevant tests, capture failures, and summarize only actionable findings.",
        tools: ["Read", "Glob", "Grep", "Bash"],
        maxTurns: 8,
      },
    },
  },
})) {
  if (message.type === "task_progress") {
    console.log(message.summary ?? "Working...");
  }

  if (message.type === "result") {
    console.log(message.result);
  }
}
```

## 7. Session history and resume

```ts
import {
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query,
} from "@anthropic-ai/claude-agent-sdk";

const sessions = await listSessions({ limit: 10, dir: process.cwd() });
const latest = sessions[0];

if (latest) {
  const info = await getSessionInfo(latest.sessionId, { dir: process.cwd() });
  const messages = await getSessionMessages(latest.sessionId, {
    dir: process.cwd(),
    limit: 20,
  });

  console.log(info?.title, messages.length);

  for await (const event of query({
    prompt: "Continue from the previous investigation and summarize the next step.",
    options: {
      cwd: process.cwd(),
      resume: latest.sessionId,
    },
  })) {
    if (event.type === "result") console.log(event.result);
  }
}
```

## 8. Structured output with `outputFormat`

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

const outputFormat = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string" },
      risks: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["summary", "risks"],
  },
};

for await (const message of query({
  prompt: "Inspect the auth module and return a structured summary.",
  options: {
    cwd: process.cwd(),
    allowedTools: ["Read", "Glob", "Grep"],
    outputFormat,
  },
})) {
  if (message.type === "result" && message.subtype === "success") {
    console.log(message.structured_output);
  }
}
```

## 9. Browser transport

```ts
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk/browser";

async function* prompt(): AsyncIterable<SDKUserMessage> {
  yield {
    type: "user",
    message: {
      role: "user",
      content: "Inspect the workspace state and summarize what changed.",
    },
    parent_tool_use_id: null,
    session_id: crypto.randomUUID(),
    cwd: "/workspace",
    uuid: crypto.randomUUID(),
  } as SDKUserMessage;
}

for await (const message of query({
  prompt: prompt(),
  websocket: { url: "wss://example.com/claude-agent" },
})) {
  if (message.type === "result") {
    console.log(message.result);
  }
}
```

Use the browser export only when the transport is WebSocket-based and the SDK is not spawning a local Claude Code subprocess.
