import { test, expect, beforeEach } from "bun:test";
import { sessions, terminals, cliSessionToTerminal, sessionLogs, wsClients, GHOST_NAMES } from "./state";
import { cleanupGhostTerminal } from "./terminals";
import { handleHook } from "./hooks";
import type { Terminal } from "./types";

function makeGhostTerminal(id: string, cwd = "/home/user"): Terminal {
  return { id, cwd, proc: null, ghost: true, subscribers: new Set(), outputBuffer: [] };
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

test("UserPromptSubmit from unknown session auto-registers a ghost terminal", () => {
  handleHook("claude", {
    hook_event_name: "UserPromptSubmit",
    session_id: "external-session-abc",
    cwd: "/home/user/myproject",
  });

  expect(sessions.size).toBe(1);
  expect(terminals.size).toBe(1);

  const session = sessions.values().next().value!;
  expect(session.state).toBe("thinking");
  expect(session.source).toBe("claude");
  expect(session.cwd).toBe("/home/user/myproject");
  expect(typeof session.name).toBe("string");
  expect(GHOST_NAMES).toContain(session.name);

  const term = terminals.values().next().value!;
  expect(term.ghost).toBe(true);
  expect(term.proc).toBeNull();
});

test("subsequent hooks reuse the same ghost terminal", () => {
  handleHook("claude", {
    hook_event_name: "UserPromptSubmit",
    session_id: "external-session-def",
    cwd: "/home/user/project",
  });

  handleHook("claude", {
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    session_id: "external-session-def",
    cwd: "/home/user/project",
  });

  // Still only 1 session and 1 terminal — no duplicates
  expect(sessions.size).toBe(1);
  expect(terminals.size).toBe(1);

  const session = sessions.values().next().value!;
  expect(session.state).toBe("reading");
});

test("non-UserPromptSubmit hook from unknown session is ignored", () => {
  handleHook("claude", {
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    session_id: "never-seen-session",
    cwd: "/home/user/project",
  });

  expect(sessions.size).toBe(0);
  expect(terminals.size).toBe(0);
});

test("Stop hook on ghost terminal enters loitering instead of being removed", () => {
  handleHook("claude", {
    hook_event_name: "UserPromptSubmit",
    session_id: "ghost-stop-session",
    cwd: "/home/user/project",
  });
  expect(sessions.size).toBe(1);
  expect(terminals.size).toBe(1);
  const [termId] = [...terminals.keys()];

  handleHook("claude", {
    hook_event_name: "Stop",
    session_id: "ghost-stop-session",
    cwd: "/home/user/project",
  });

  // Terminal and session are still present — loitering, not removed
  expect(terminals.has(termId)).toBe(true);
  expect(sessions.size).toBe(1);
  const s = sessions.get(termId)!;
  expect(s.state).toBe("waiting");
  expect(typeof s.loiteringUntil).toBe("number");
  expect(s.loiteringUntil!).toBeGreaterThan(Date.now() - 1_000);
  expect(s.loiteringUntil!).toBeLessThanOrEqual(Date.now() + 60_001);
  // cliSessionToTerminal still maps — don't clean up yet
  expect(cliSessionToTerminal.size).toBeGreaterThan(0);
});

test("Stop hook on real (non-ghost) terminal sets state to waiting, does not remove it", () => {
  const realId = "term-real-99";
  // Register a real terminal (ghost: undefined/false)
  terminals.set(realId, {
    id: realId, cwd: "/home/user", proc: {} as any,
    subscribers: new Set(), outputBuffer: [],
  });
  cliSessionToTerminal.set("real-cli-session", realId);
  sessions.set(realId, {
    id: realId, cwd: "/home/user", state: "thinking", source: "claude",
    lastSeen: Date.now(), startedAt: Date.now(), stateChangedAt: Date.now(),
  });

  handleHook("claude", {
    hook_event_name: "Stop",
    session_id: "real-cli-session",
    cwd: "/home/user",
    observatory_terminal_id: realId,
  });

  expect(terminals.has(realId)).toBe(true);       // terminal stays
  expect(sessions.get(realId)?.state).toBe("waiting");  // state → waiting
});
