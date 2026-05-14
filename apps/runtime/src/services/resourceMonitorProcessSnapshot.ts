import os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const EXEC_TIMEOUT_MS = 5_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export interface ResourceMonitorProcessInfo {
  pid: number;
  ppid: number;
  cpu: number;
  memory: number;
  command: string;
}

export interface ResourceMonitorProcessSnapshot {
  byPid: Map<number, ResourceMonitorProcessInfo>;
  childrenOf: Map<number, number[]>;
}

export interface ResourceMonitorUsageValues {
  cpu: number;
  memory: number;
}

function normalizeFiniteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, value);
}

async function listUnixProcesses(): Promise<ResourceMonitorProcessInfo[]> {
  try {
    const { stdout } = await execAsync("ps -eo pid=,ppid=,pcpu=,rss=,comm=", {
      maxBuffer: MAX_BUFFER_BYTES,
      timeout: EXEC_TIMEOUT_MS,
    });
    const processes: ResourceMonitorProcessInfo[] = [];

    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      const match = /^(\d+)\s+(\d+)\s+([0-9.]+)\s+(\d+)\s+(.+)$/.exec(trimmed);
      if (!match) {
        continue;
      }

      const pid = Number.parseInt(match[1] ?? "", 10);
      const ppid = Number.parseInt(match[2] ?? "", 10);
      const cpu = Number.parseFloat(match[3] ?? "");
      const rssKb = Number.parseInt(match[4] ?? "", 10);
      const command = (match[5] ?? "").trim();

      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) {
        continue;
      }

      processes.push({
        pid,
        ppid,
        cpu: normalizeFiniteNumber(cpu),
        memory: normalizeFiniteNumber(rssKb) * 1024,
        command,
      });
    }

    return processes;
  } catch {
    return [];
  }
}

async function listWindowsProcesses(): Promise<ResourceMonitorProcessInfo[]> {
  try {
    const { stdout } = await execAsync(
      "powershell -NoProfile -Command \"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,Name | ConvertTo-Csv -NoTypeInformation\"",
      {
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: EXEC_TIMEOUT_MS,
      },
    );
    const processes: ResourceMonitorProcessInfo[] = [];

    for (const line of stdout.trim().split("\n").slice(1)) {
      const trimmed = line.trim().replaceAll("\"", "");
      if (trimmed.length === 0) {
        continue;
      }

      const [pidRaw, ppidRaw, memoryRaw, commandRaw] = trimmed.split(",", 4);
      const pid = Number.parseInt(pidRaw ?? "", 10);
      const ppid = Number.parseInt(ppidRaw ?? "", 10);
      const memory = Number.parseInt(memoryRaw ?? "", 10);

      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) {
        continue;
      }

      processes.push({
        pid,
        ppid,
        cpu: 0,
        memory: normalizeFiniteNumber(memory),
        command: (commandRaw ?? "").trim(),
      });
    }

    return processes;
  } catch {
    return [];
  }
}

export async function captureResourceMonitorProcessSnapshot(): Promise<ResourceMonitorProcessSnapshot> {
  const rawProcesses = os.platform() === "win32"
    ? await listWindowsProcesses()
    : await listUnixProcesses();

  const byPid = new Map<number, ResourceMonitorProcessInfo>();
  const childrenOf = new Map<number, number[]>();

  for (const processInfo of rawProcesses) {
    byPid.set(processInfo.pid, processInfo);
    const existingChildren = childrenOf.get(processInfo.ppid);
    if (existingChildren) {
      existingChildren.push(processInfo.pid);
      continue;
    }

    childrenOf.set(processInfo.ppid, [processInfo.pid]);
  }

  return { byPid, childrenOf };
}

export function getSubtreePids(
  snapshot: ResourceMonitorProcessSnapshot,
  rootPid: number,
): number[] {
  const result: number[] = [];
  const stack = [rootPid];
  const visited = new Set<number>();

  while (stack.length > 0) {
    const currentPid = stack.pop();
    if (currentPid == null || visited.has(currentPid)) {
      continue;
    }

    visited.add(currentPid);

    if (snapshot.byPid.has(currentPid)) {
      result.push(currentPid);
    }

    const childPids = snapshot.childrenOf.get(currentPid);
    if (!childPids) {
      continue;
    }

    for (const childPid of childPids) {
      stack.push(childPid);
    }
  }

  return result;
}

export function sumResourcesForPids(
  snapshot: ResourceMonitorProcessSnapshot,
  pids: Iterable<number>,
): ResourceMonitorUsageValues {
  let cpu = 0;
  let memory = 0;

  for (const pid of pids) {
    const processInfo = snapshot.byPid.get(pid);
    if (!processInfo) {
      continue;
    }

    cpu += processInfo.cpu;
    memory += processInfo.memory;
  }

  return {
    cpu: normalizeFiniteNumber(cpu),
    memory: normalizeFiniteNumber(memory),
  };
}

export function getSubtreeResources(
  snapshot: ResourceMonitorProcessSnapshot,
  rootPid: number,
): ResourceMonitorUsageValues & { pids: number[] } {
  const pids = getSubtreePids(snapshot, rootPid);
  return {
    ...sumResourcesForPids(snapshot, pids),
    pids,
  };
}
