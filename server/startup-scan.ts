import { spawn } from "bun";
import { readlink } from "fs/promises";
import { terminals, sessions, generateGhostName } from "./state";
import { upsertSession } from "./sessions";

const AGENT_RE  = /\b(claude|cursor|copilot|gemini)\b/i;
const NOISE_RE  = /observatory|hook\.js|grep/i;

/** Extract PIDs of running AI agent processes from `ps aux` output. */
export function parseAgentPids(psOutput: string): string[] {
  const pids: string[] = [];
  for (const line of psOutput.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 11) continue;
    const pid = parts[1];
    const cmd = parts.slice(10).join(" ");
    if (AGENT_RE.test(cmd) && !NOISE_RE.test(cmd)) pids.push(pid);
  }
  return pids;
}

/** Scan running agent processes and register ghost sessions for unknown ones. */
export async function scanRunningSessions(): Promise<void> {
  try {
    const proc = spawn(["ps", "aux"], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    const pids = parseAgentPids(output);

    // Collect cwds already tracked to avoid duplicates
    const knownCwds = new Set<string>();
    for (const term of terminals.values()) knownCwds.add(term.cwd);

    for (const pid of pids) {
      try {
        const cwd = await readlink(`/proc/${pid}/cwd`);
        if (knownCwds.has(cwd)) continue;
        knownCwds.add(cwd);

        const ghostId = `startup-${pid}`;
        const name = generateGhostName();
        terminals.set(ghostId, {
          id: ghostId, cwd, proc: null, ghost: true,
          subscribers: new Set(), outputBuffer: [],
        });
        upsertSession(ghostId, cwd, "waiting", "claude", name);
        const s = sessions.get(ghostId);
        if (s) s.ghost = true;
        console.log(`[startup] ghost registered for pid ${pid} at ${cwd} (${name})`);
      } catch {
        // process exited or /proc not readable — skip silently
      }
    }
  } catch {
    // ps unavailable (macOS, permission denied) — silent fallback
  }
}
