import { test, expect, beforeEach } from "bun:test";
import { sessions, terminals, cliSessionToTerminal, sessionLogs, wsClients } from "./state";
import { cleanupGhostTerminal } from "./terminals";
import type { Terminal } from "./types";

function makeGhostTerminal(id: string, cwd = "/home/user"): Terminal {
  return { id, cwd, proc: null as any, ghost: true, subscribers: new Set(), outputBuffer: [] };
}

beforeEach(() => {
  sessions.clear();
  terminals.clear();
  cliSessionToTerminal.clear();
  sessionLogs.clear();
  wsClients.clear();
});

test("cleanupGhostTerminal removes ghost from terminals, sessions, sessionLogs, and cliSessionToTerminal", () => {
  const ghostId = "ghost-abc12345-1000";
  terminals.set(ghostId, makeGhostTerminal(ghostId));
  sessions.set(ghostId, { id: ghostId, cwd: "/home/user", state: "thinking", source: "claude", lastSeen: Date.now(), startedAt: Date.now(), stateChangedAt: Date.now(), name: "Ada" });
  sessionLogs.set(ghostId, []);
  cliSessionToTerminal.set("cli-session-abc12345", ghostId);

  cleanupGhostTerminal(ghostId);

  expect(terminals.has(ghostId)).toBe(false);
  expect(sessions.has(ghostId)).toBe(false);
  expect(sessionLogs.has(ghostId)).toBe(false);
  expect(cliSessionToTerminal.get("cli-session-abc12345")).toBeUndefined();
});
