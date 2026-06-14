import { runCursorSdkTurn } from "../cursor/sdk/runTurn.js";
import { resolveCursorApiKey } from "../cursor/sdk/auth.js";
import { listCursorSdkModelCatalog } from "../cursor/sdk/catalog.js";
import { loadCursorSdkMcpServers } from "../cursor/sdk/mcpServers.js";
import { disposeAllCursorSdkAgents } from "../cursor/sdk/agentPool.js";
import { resolveCursorSdkModelSelection } from "@codesymphony/shared-types";

let unhandled = 0;
process.on("unhandledRejection", (r:any) => { unhandled++; console.error("  [unhandledRejection]", r?.message ?? r); });

const CWD = process.env.HOME + "/Work/likearthstudio/dws-mobile";
const apiKey = resolveCursorApiKey();
const mcpServers = loadCursorSdkMcpServers();
function cbs(){return{onText:()=>{},onToolStarted:async()=>{},onToolOutput:async()=>{},onToolFinished:async()=>{},onQuestionRequest:async()=>({answers:{}}),onPermissionRequest:async()=>({decision:"allow" as const}),onPlanFileDetected:async()=>{},onTodoUpdate:async()=>{},onSubagentStarted:async()=>{},onSubagentStopped:async()=>{},onThinking:async()=>{}};}

(async () => {
  const catalog = await listCursorSdkModelCatalog({ apiKey });
  const N = parseInt(process.env.N ?? "10", 10);
  let hang=0, err=0, ok=0;
  for (let i=0;i<N;i++){
    const fast = i % 2 === 1;
    const sdkModel = resolveCursorSdkModelSelection({ model: "composer-2.5", modelOptions: [{ id: "fastMode", value: fast }], catalog });
    const t0=Date.now();
    let timedOut=false;
    try {
      const res:any = await Promise.race([
        runCursorSdkTurn({ prompt:"Reply with exactly: OK_"+i, sessionId:null, cwd:CWD, apiKey, permissionMode:"full_access" as any, threadPermissionMode:"full_access" as any, model:sdkModel, mcpServers, onSessionId:()=>{}, ...cbs() }),
        new Promise((_,rej)=>setTimeout(()=>{timedOut=true;rej(new Error("WATCHDOG-40s"));},40000)),
      ]);
      ok++; console.log(`#${i} fast=${fast} OK ${Date.now()-t0}ms out=${res.output.length}`);
    } catch(e:any){
      if (timedOut){hang++; console.log(`#${i} fast=${fast} HANG ${Date.now()-t0}ms`);}
      else {err++; console.log(`#${i} fast=${fast} ERR ${Date.now()-t0}ms ${e?.message}`);}
    }
  }
  console.log(`\nRESULT ok=${ok} err=${err} hang=${hang} unhandledRejections=${unhandled}`);
  await disposeAllCursorSdkAgents();
  process.exit(0);
})().catch(e=>{console.error("TOP",e?.message??e);process.exit(1);});
