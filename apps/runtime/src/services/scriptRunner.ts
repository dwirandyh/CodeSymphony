import { exec } from "node:child_process";

export interface ScriptResult {
  success: boolean;
  output: string;
}

export async function runScripts(
  commands: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<ScriptResult> {
  const mergedEnv = { ...process.env, ...env };
  const outputs: string[] = [];

  for (const command of commands) {
    try {
      const output = await new Promise<string>((resolve, reject) => {
        exec(command, { cwd, env: mergedEnv, timeout: 300_000 }, (error, stdout, stderr) => {
          const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
          if (error) {
            reject(new Error(`Command "${command}" failed: ${combined || error.message}`));
          } else {
            resolve(combined);
          }
        });
      });
      if (output) outputs.push(output);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outputs.push(message);
      return { success: false, output: outputs.join("\n") };
    }
  }

  return { success: true, output: outputs.join("\n") };
}
