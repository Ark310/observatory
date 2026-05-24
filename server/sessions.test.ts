import { test, expect, beforeEach } from "bun:test";
import { generateGhostName, GHOST_NAMES, sessions, wsClients, terminals, sessionLogs } from "./state";
import { upsertSession, pruneStale } from "./sessions";
import type { Terminal } from "./types";

beforeEach(() => {
  sessions.clear();
  terminals.clear();
  sessionLogs.clear();
  wsClients.clear();   // prevents broadcast errors
});

test("generateGhostName returns a non-empty string", () => {
  const name = generateGhostName();
  expect(typeof name).toBe("string");
  expect(name.length).toBeGreaterThan(0);
});

test("generateGhostName returns a value from GHOST_NAMES", () => {
  const name = generateGhostName();
  expect(GHOST_NAMES).toContain(name);
});

test("upsertSession stores name on new session", () => {
  upsertSession("term-1", "/home/user/project", "thinking", "claude", "Ada");
  const session = sessions.get("term-1");
  expect(session?.name).toBe("Ada");
});

test("upsertSession preserves existing name when none provided on update", () => {
  upsertSession("term-1", "/home/user", "thinking", "claude", "Ada");
  upsertSession("term-1", "/home/user", "editing", "claude");          // no name arg
  const session = sessions.get("term-1");
  expect(session?.name).toBe("Ada");
});

test("upsertSession with no name leaves name undefined", () => {
  upsertSession("term-1", "/home/user", "thinking", "claude");
  const session = sessions.get("term-1");
  expect(session?.name).toBeUndefined();
});

test("pruneStale removes a ghost terminal whose lastSeen is older than 15 minutes", () => {
  const ghostId = "ghost-stale-123";
  const staleTime = Date.now() - 16 * 60 * 1000;  // 16 minutes ago

  terminals.set(ghostId, {
    id: ghostId, cwd: "/home/user", proc: null as any,
    ghost: true, subscribers: new Set(), outputBuffer: [],
  } as Terminal);
  sessions.set(ghostId, {
    id: ghostId, cwd: "/home/user", state: "waiting", source: "claude",
    lastSeen: staleTime, startedAt: staleTime, stateChangedAt: staleTime, name: "Turing",
  });
  sessionLogs.set(ghostId, []);

  pruneStale();

  expect(terminals.has(ghostId)).toBe(false);
  expect(sessions.has(ghostId)).toBe(false);
  expect(sessionLogs.has(ghostId)).toBe(false);
});

test("pruneStale does NOT remove a ghost terminal that was active within 15 minutes", () => {
  const ghostId = "ghost-fresh-456";
  const recentTime = Date.now() - 5 * 60 * 1000;  // 5 minutes ago

  terminals.set(ghostId, {
    id: ghostId, cwd: "/home/user", proc: null as any,
    ghost: true, subscribers: new Set(), outputBuffer: [],
  } as Terminal);
  sessions.set(ghostId, {
    id: ghostId, cwd: "/home/user", state: "thinking", source: "claude",
    lastSeen: recentTime, startedAt: recentTime, stateChangedAt: recentTime, name: "Hopper",
  });

  pruneStale();

  expect(terminals.has(ghostId)).toBe(true);
  expect(sessions.has(ghostId)).toBe(true);
});

test("upsertSession preserves ghost flag across state updates", () => {
  sessions.set("ghost-abc", {
    id: "ghost-abc", cwd: "/p", state: "thinking", source: "claude",
    ghost: true,
    lastSeen: Date.now(), startedAt: Date.now(), stateChangedAt: Date.now(),
  });

  upsertSession("ghost-abc", "/p", "editing", "claude");

  expect(sessions.get("ghost-abc")?.ghost).toBe(true);
});

test("upsertSession preserves loiteringUntil across state updates", () => {
  const until = Date.now() + 50_000;
  sessions.set("ghost-xyz", {
    id: "ghost-xyz", cwd: "/p", state: "waiting", source: "claude",
    ghost: true, loiteringUntil: until,
    lastSeen: Date.now(), startedAt: Date.now(), stateChangedAt: Date.now(),
  });

  upsertSession("ghost-xyz", "/p", "waiting", "claude");

  expect(sessions.get("ghost-xyz")?.loiteringUntil).toBe(until);
});
