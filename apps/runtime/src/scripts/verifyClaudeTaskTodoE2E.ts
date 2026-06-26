const API = "http://127.0.0.1:4331/api";
// codesymphony worktree (same as the captured bug thread cmqtjfvw7000vm944pmh1x4m8)
const WORKTREE_ID = "cmpwonlpt0002m999cnb13xf6";
// Same agent/model/provider as the bug thread so we exercise the exact Task* path.
const AGENT = "claude";
const MODEL = "xai/composer-2.5";
const MODEL_PROVIDER_ID = "cmq2cfkbn001om9f7u9ypf3la";
const PROMPT =
  "Buatkan harmless task to do 4 item command terminal simple saja (echo, pwd, ls, date), ini untuk testing. Wajib pakai task list dan update status tiap langkah sampai selesai.";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} -> ${response.status}: ${JSON.stringify(body)}`);
  }
  return body as T;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForEvent(threadId: string, type: string, timeoutMs = 240_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const events = await api<{ data: Array<{ type: string }> }>(`/threads/${threadId}/events?limit=500`);
    if (events.data.some((event) => event.type === type)) {
      return;
    }
    await sleep(2000);
  }
  throw new Error(`Timed out waiting for event ${type} on ${threadId}`);
}

async function analyze(threadId: string) {
  const events = await api<{ data: Array<{ idx: number; type: string; payload: Record<string, unknown> }> }>(
    `/threads/${threadId}/events?limit=500`,
  );
  const todoUpdated = events.data.filter((e) => e.type === "todo.updated");
  const taskTools = events.data.filter((e) => {
    const name = String((e.payload as { toolName?: unknown }).toolName ?? "").toLowerCase();
    return name.startsWith("task");
  });
  const timeline = await api<{ data: { timelineItems: Array<{ kind: string; toolName?: string; items?: unknown[] }> } }>(
    `/threads/${threadId}/timeline?mode=compact`,
  );
  const items = timeline.data.timelineItems;
  const todoList = items.filter((i) => i.kind === "todo-list");
  const genericTaskRows = items.filter(
    (i) => i.kind === "tool" && /^task(create|update|list|get)$/i.test(String(i.toolName ?? "").trim()),
  );
  return {
    eventCount: events.data.length,
    todoUpdatedCount: todoUpdated.length,
    rawTaskToolEvents: taskTools.length,
    todoListCount: todoList.length,
    todoListItemCounts: todoList.map((i) => (Array.isArray(i.items) ? i.items.length : 0)),
    genericTaskTimelineRows: genericTaskRows.length,
  };
}

async function main() {
  const title = `E2E claude task-todo ${new Date().toISOString().slice(11, 19)}`;
  console.log("Creating thread...");
  const created = await api<{ data: { id: string } }>(`/worktrees/${WORKTREE_ID}/threads`, {
    method: "POST",
    body: JSON.stringify({
      title,
      agent: AGENT,
      model: MODEL,
      modelProviderId: MODEL_PROVIDER_ID,
      permissionMode: "full_access",
    }),
  });
  const threadId = created.data.id;
  console.log("Thread:", threadId);

  console.log("Sending prompt (default mode, full_access)...");
  await api(`/threads/${threadId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content: PROMPT, mode: "default", expectedWorktreeId: WORKTREE_ID }),
  });

  console.log("Waiting for completion...");
  await waitForEvent(threadId, "chat.completed", 300_000);
  await sleep(2000);

  const result = await analyze(threadId);
  console.log(JSON.stringify(result, null, 2));

  const ok =
    result.todoUpdatedCount >= 2 &&
    result.todoListCount === 1 &&
    result.genericTaskTimelineRows === 0;

  if (ok) {
    console.log("VERIFICATION PASSED");
    console.log(
      `Open: http://localhost:5173/?repoId=cmpwonlpq0000m999ecn29zin&worktreeId=${WORKTREE_ID}&threadId=${threadId}`,
    );
  } else {
    process.exitCode = 1;
    console.error("VERIFICATION FAILED");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
