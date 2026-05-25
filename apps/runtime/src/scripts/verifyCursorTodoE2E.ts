const API = "http://127.0.0.1:4331/api";
const WORKTREE_ID = "cmnric2820alom9a8qabz4ej1";
const PROMPT = "saya ingin update README.md agar last updatednya jadi now. Wajib pakai todo list (TodoWrite) dan update status todo di setiap langkah.";

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

async function waitForStatus(threadId: string, wanted: Set<string>, timeoutMs = 180_000): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const snapshot = await api<{ data: { status: string } }>(`/threads/${threadId}/status-snapshot`);
    const status = snapshot.data.status;
    if (wanted.has(status)) {
      return status;
    }
    await sleep(1500);
  }
  throw new Error(`Timed out waiting for status ${[...wanted].join("|")} on ${threadId}`);
}

async function waitForEvent(threadId: string, type: string, timeoutMs = 180_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const events = await api<{ data: Array<{ type: string }> }>(`/threads/${threadId}/events?limit=500`);
    if (events.data.some((event) => event.type === type)) {
      return;
    }
    await sleep(1500);
  }
  throw new Error(`Timed out waiting for event ${type} on ${threadId}`);
}

async function analyzeThread(threadId: string) {
  const events = await api<{ data: Array<{ idx: number; type: string; payload: Record<string, unknown> }> }>(
    `/threads/${threadId}/events?limit=500`,
  );
  const todoUpdated = events.data.filter((event) => event.type === "todo.updated");
  const updateTodoTools = events.data.filter((event) => {
    const serialized = JSON.stringify(event.payload).toLowerCase();
    return serialized.includes("update todos") || serialized.includes("updatetodos");
  });
  const timeline = await api<{ data: { timelineItems: Array<{ kind: string; content?: string; toolName?: string }> } }>(
    `/threads/${threadId}/timeline?mode=compact`,
  );
  const todoProgress = timeline.data.timelineItems.filter((item) => item.kind === "todo-progress");
  const todoList = timeline.data.timelineItems.filter((item) => item.kind === "todo-list");
  const updateTodoRows = timeline.data.timelineItems.filter((item) =>
    item.kind === "tool" && JSON.stringify(item).toLowerCase().includes("update todos"),
  );

  return {
    eventCount: events.data.length,
    todoUpdatedCount: todoUpdated.length,
    todoUpdatedSnapshots: todoUpdated.map((event) => ({
      idx: event.idx,
      items: event.payload.items,
    })),
    updateTodoToolEventCount: updateTodoTools.length,
    todoProgressCount: todoProgress.length,
    todoListCount: todoList.length,
    updateTodoTimelineRows: updateTodoRows.length,
    lastStatuses: events.data.slice(-5).map((event) => ({ idx: event.idx, type: event.type })),
  };
}

async function main() {
  const title = `E2E todo ${new Date().toISOString().slice(11, 19)}`;
  console.log("Creating thread...");
  const created = await api<{ data: { id: string } }>(`/worktrees/${WORKTREE_ID}/threads`, {
    method: "POST",
    body: JSON.stringify({
      title,
      agent: "cursor",
      model: "default[]",
      permissionMode: "full_access",
    }),
  });
  const threadId = created.data.id;
  console.log("Thread:", threadId);

  await api(`/threads/${threadId}/mode`, {
    method: "PATCH",
    body: JSON.stringify({ mode: "plan" }),
  });

  console.log("Sending plan prompt...");
  await api(`/threads/${threadId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content: PROMPT,
      mode: "plan",
      expectedWorktreeId: WORKTREE_ID,
    }),
  });

  console.log("Waiting for plan review...");
  await waitForEvent(threadId, "plan.created");
  await waitForStatus(threadId, new Set(["review_plan"]), 300_000);
  await waitForStatus(threadId, new Set(["review_plan", "idle"]), 60_000);

  console.log("Approving plan...");
  let approved = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await api(`/threads/${threadId}/plan/approve`, {
        method: "POST",
        body: JSON.stringify({
          agent: "cursor",
          model: "default[]",
        }),
      });
      approved = true;
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("Assistant is still processing")) {
        throw error;
      }
      await sleep(2000);
    }
  }
  if (!approved) {
    throw new Error("Unable to approve plan after retries");
  }

  console.log("Waiting for execution to finish...");
  await waitForEvent(threadId, "chat.completed", 300_000);
  await waitForStatus(threadId, new Set(["idle"]), 180_000);

  const analysis = await analyzeThread(threadId);
  console.log(JSON.stringify(analysis, null, 2));

  const success = analysis.todoUpdatedCount >= 2
    && analysis.todoProgressCount >= 1
    && analysis.updateTodoTimelineRows === 0
    && analysis.updateTodoToolEventCount >= 1;

  if (!success) {
    process.exitCode = 1;
    console.error("VERIFICATION FAILED");
  } else {
    console.log("VERIFICATION PASSED");
    console.log(`Open: http://localhost:5173/?repoId=cmnric2800almm9a8am7vxkhq&worktreeId=${WORKTREE_ID}&threadId=${threadId}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
