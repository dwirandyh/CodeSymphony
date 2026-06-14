import { configureCursorSdk, Agent } from "@cursor/sdk";
import { resolveCursorApiKey } from "../cursor/sdk/auth.js";
import { loadCursorSdkMcpServers } from "../cursor/sdk/mcpServers.js";

const http1 = process.env.HTTP1 === "1";
const useMcp = process.env.MCP === "1";
if (http1) configureCursorSdk({ local: { useHttp1ForAgent: true } });
const CWD = process.env.CWD_OVERRIDE || (process.env.HOME + "/Work/likearthstudio/dws-mobile");
const apiKey = resolveCursorApiKey();
const mcpServers = useMcp ? loadCursorSdkMcpServers() : {};

(async () => {
  console.log("http1=", http1, "mcp=", Object.keys(mcpServers));
  const agent = await Agent.create({ apiKey, model: { id: "composer-2.5", params:[{id:"fast",value:"false"}] }, mcpServers, mode: "agent", local: { cwd: CWD } });
  const run = await agent.send("Reply with exactly: HELLO_PHASE_1", { mode: "agent" });
  for await (const m of run.stream()) {
    console.log("MSG type=", (m as any).type, JSON.stringify(m).slice(0,300));
  }
  const r = await run.wait();
  console.log("WAIT status=", r.status, "result=", r.result);
  await agent[Symbol.asyncDispose]();
  process.exit(0);
})().catch(e=>{console.error("ERR", e?.message ?? e); process.exit(1);});
