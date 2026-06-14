import { runCursorSdkTurn } from "../cursor/sdk/runTurn.js";
import { resolveCursorApiKey } from "../cursor/sdk/auth.js";
import { listCursorSdkModelCatalog } from "../cursor/sdk/catalog.js";
import { loadCursorSdkMcpServers } from "../cursor/sdk/mcpServers.js";
import { disposeAllCursorSdkAgents } from "../cursor/sdk/agentPool.js";
import { resolveCursorSdkModelSelection } from "@codesymphony/shared-types";

process.on("unhandledRejection", (r) => { console.error("!!! UNHANDLED REJECTION:", (r as any)?.message ?? r); });
process.on("uncaughtException", (e) => { console.error("!!! UNCAUGHT EXCEPTION:", e?.message ?? e); });

const CWD = process.env.HOME + "/Work/likearthstudio/dws-mobile";
function cbs() {
  return { onText: (t: string) => process.stdout.write(t), onToolStarted: async () => {}, onToolOutput: async () => {},
    onToolFinished: async () => {}, onQuestionRequest: async () => ({ answers: {} }),
    onPermissionRequest: async () => ({ decision: "allow" as const }), onPlanFileDetected: async () => {},
    onTodoUpdate: async () => {}, onSubagentStarted: async () => {}, onSubagentStopped: async () => {}, onThinking: async () => {} };
}
const apiKey = resolveCursorApiKey();
const mcpServers = loadCursorSdkMcpServers();

async function phase(label: string, prompt: string, sessionId: string | null, fast: boolean, catalog: any) {
  const sdkModel = resolveCursorSdkModelSelection({ model: "composer-2.5", modelOptions: [{ id: "fastMode", value: fast }], catalog });
  console.log(`\n=== ${label} session=${sessionId} ===`);
  const t0 = Date.now();
  try {
    const res: any = await runCursorSdkTurn({ prompt, sessionId, cwd: CWD, apiKey,
      permissionMode: "full_access" as any, threadPermissionMode: "full_access" as any,
      model: sdkModel, mcpServers, onSessionId: () => {}, ...cbs() });
    console.log(`\n[${label}] DONE ${Date.now()-t0}ms session=${res.sessionId} outLen=${res.output.length}`);
    return res.sessionId;
  } catch (e:any) {
    console.log(`\n[${label}] CAUGHT after ${Date.now()-t0}ms: ${e?.name}: ${e?.message}`);
    return sessionId;
  }
}
(async () => {
  const catalog = await listCursorSdkModelCatalog({ apiKey });
  let s = await phase("p1", "Reply with exactly: HELLO_PHASE_1", null, false, catalog);
  s = await phase("p2", "Reply with exactly: NUMBER_42", s, true, catalog);
  s = await phase("p3", "Reply with exactly: BYE_PHASE_3", s, false, catalog);
  console.log("\nALL DONE", s);
  await new Promise(r=>setTimeout(r,2000));
  await disposeAllCursorSdkAgents();
  process.exit(0);
})().catch((e) => { console.error("TOP ERROR", e?.message ?? e); process.exit(1); });
